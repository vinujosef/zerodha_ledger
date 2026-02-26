from __future__ import annotations

from datetime import date
from typing import List, Dict, Any

import pandas as pd

from ..base import TaxCalculator
from ..types import TaxReportRequest


class FinlandTaxCalculator(TaxCalculator):
    """
    Finland capital-gains calculator.

    This file intentionally contains only Finland-specific tax logic and is
    referenced through the country registry/engine.
    """
    country_code = "FI"

    @staticmethod
    def _sanitize_trades_df(trades_df: pd.DataFrame) -> pd.DataFrame:
        if trades_df is None or trades_df.empty:
            return pd.DataFrame(columns=["trade_id", "symbol", "date", "type", "quantity", "price", "gross_amount"])
        df = trades_df.copy()
        if "date" not in df.columns:
            raise ValueError("Trades data is missing 'date' column.")
        if "type" not in df.columns:
            raise ValueError("Trades data is missing 'type' column.")
        if "quantity" not in df.columns or "price" not in df.columns:
            raise ValueError("Trades data is missing 'quantity' or 'price' column.")

        if "trade_id" not in df.columns:
            df["trade_id"] = ""
        if "symbol" not in df.columns:
            df["symbol"] = ""
        if "gross_amount" not in df.columns:
            df["gross_amount"] = df["quantity"].astype(float) * df["price"].astype(float)

        df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.date
        df = df[df["date"].notna()].copy()
        df["type"] = df["type"].astype(str).str.upper()
        df["symbol"] = df["symbol"].astype(str).str.upper()
        df["quantity"] = df["quantity"].astype(float)
        df["price"] = df["price"].astype(float)
        df["gross_amount"] = df["gross_amount"].astype(float)
        return df[["trade_id", "symbol", "date", "type", "quantity", "price", "gross_amount"]].copy()

    @staticmethod
    def _sanitize_notes_df(notes_df: pd.DataFrame) -> pd.DataFrame:
        if notes_df is None or notes_df.empty:
            return pd.DataFrame(columns=["date", "total_brokerage", "total_taxes", "total_other_charges"])
        df = notes_df.copy()
        if "date" not in df.columns:
            return pd.DataFrame(columns=["date", "total_brokerage", "total_taxes", "total_other_charges"])
        df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.date
        df = df[df["date"].notna()].copy()
        for col in ["total_brokerage", "total_taxes", "total_other_charges"]:
            if col not in df.columns:
                df[col] = 0.0
            df[col] = df[col].fillna(0.0).astype(float)
        return df[["date", "total_brokerage", "total_taxes", "total_other_charges"]].copy()

    @staticmethod
    def _apply_daily_charge_allocations(trades_df: pd.DataFrame, notes_df: pd.DataFrame) -> pd.DataFrame:
        if trades_df.empty:
            return trades_df.copy()
        # Current data model stores fees aggregated per contract-note day.
        # We allocate the day's fees to each trade by turnover share.
        merged = trades_df.merge(notes_df, on="date", how="left")
        merged["total_brokerage"] = merged.get("total_brokerage", 0.0).fillna(0.0)
        merged["total_taxes"] = merged.get("total_taxes", 0.0).fillna(0.0)
        merged["total_other_charges"] = merged.get("total_other_charges", 0.0).fillna(0.0)
        merged["daily_charges"] = (
            merged["total_brokerage"].abs()
            + merged["total_taxes"].abs()
            + merged["total_other_charges"].abs()
        )
        daily_turnover = merged.groupby("date")["gross_amount"].transform("sum")
        merged["allocated_charge"] = 0.0
        mask = daily_turnover > 0
        merged.loc[mask, "allocated_charge"] = (
            merged.loc[mask, "gross_amount"] / daily_turnover.loc[mask]
        ) * merged.loc[mask, "daily_charges"]
        merged["net_price"] = merged.apply(
            lambda x: (x["gross_amount"] + x["allocated_charge"]) / x["quantity"]
            if x["type"] == "BUY"
            else (x["gross_amount"] - x["allocated_charge"]) / x["quantity"],
            axis=1,
        )
        return merged

    @staticmethod
    def _holding_years(buy_date: date, sell_date: date) -> float:
        delta_days = (sell_date - buy_date).days
        return max(0.0, float(delta_days) / 365.25)

    @staticmethod
    def _held_at_least_10_years(buy_date: date, sell_date: date) -> bool:
        if sell_date < buy_date:
            return False
        try:
            ten_year_mark = buy_date.replace(year=buy_date.year + 10)
        except ValueError:
            # Handles Feb 29 -> Feb 28 on non-leap year.
            ten_year_mark = buy_date.replace(month=2, day=28, year=buy_date.year + 10)
        return sell_date >= ten_year_mark

    @staticmethod
    def _deemed_rate_for_lot(buy_date: date, sell_date: date) -> float:
        return 0.40 if FinlandTaxCalculator._held_at_least_10_years(buy_date, sell_date) else 0.20

    @staticmethod
    def _tax_from_progressive_rate(taxable_amount: float) -> float:
        if taxable_amount <= 0:
            return 0.0
        lower_band = min(30000.0, taxable_amount) * 0.30
        upper_band = max(0.0, taxable_amount - 30000.0) * 0.34
        return lower_band + upper_band

    def _calculate_rows(
        self,
        merged_df: pd.DataFrame,
        tax_year: int,
        method_mode: str,
    ) -> List[Dict[str, Any]]:
        # FIFO inventory by symbol. Each BUY appends a lot, each SELL consumes oldest lots first.
        lots: Dict[str, List[Dict[str, Any]]] = {}
        rows: List[Dict[str, Any]] = []
        trade_index = 0

        for _, trade in merged_df.sort_values(["date", "trade_id"]).iterrows():
            symbol = str(trade["symbol"] or "").upper()
            side = str(trade["type"] or "").upper()
            if side == "BUY":
                lots.setdefault(symbol, []).append(
                    {
                        "qty": float(trade["quantity"]),
                        "buy_date": trade["date"],
                        "gross_buy_price": float(trade["price"]),
                        "net_buy_price": float(trade["net_price"]),
                    }
                )
                continue

            if side != "SELL":
                continue

            sell_date = trade["date"]
            if sell_date.year != tax_year:
                # FIFO inventory still needs to consume sells from other years for correct lot positions.
                pass

            qty_to_sell = float(trade["quantity"])
            gross_sell_price = float(trade["price"])
            net_sell_price = float(trade["net_price"])
            alloc_sell_per_unit = max(0.0, gross_sell_price - net_sell_price)

            proceeds = 0.0
            actual_acquisition_cost = 0.0
            deductible_expenses = 0.0
            deemed_cost = 0.0
            avg_holding_years_weighted = 0.0
            matched_qty = 0.0

            lots_for_symbol = lots.setdefault(symbol, [])
            while qty_to_sell > 1e-7 and lots_for_symbol:
                lot = lots_for_symbol[0]
                take_qty = min(float(lot["qty"]), qty_to_sell)
                if take_qty <= 0:
                    lots_for_symbol.pop(0)
                    continue

                lot_proceeds = gross_sell_price * take_qty
                lot_actual_acq = float(lot["gross_buy_price"]) * take_qty
                lot_buy_charge = max(0.0, (float(lot["net_buy_price"]) - float(lot["gross_buy_price"])) * take_qty)
                lot_sell_charge = alloc_sell_per_unit * take_qty
                lot_holding_years = self._holding_years(lot["buy_date"], sell_date)
                lot_deemed_rate = self._deemed_rate_for_lot(lot["buy_date"], sell_date)
                lot_deemed_cost = lot_proceeds * lot_deemed_rate

                proceeds += lot_proceeds
                actual_acquisition_cost += lot_actual_acq
                deductible_expenses += lot_buy_charge + lot_sell_charge
                deemed_cost += lot_deemed_cost
                avg_holding_years_weighted += lot_holding_years * take_qty
                matched_qty += take_qty

                lot["qty"] = float(lot["qty"]) - take_qty
                qty_to_sell -= take_qty
                if lot["qty"] <= 1e-7:
                    lots_for_symbol.pop(0)

            if matched_qty <= 0:
                trade_index += 1
                continue

            actual_gain = proceeds - (actual_acquisition_cost + deductible_expenses)
            deemed_gain = proceeds - deemed_cost

            if method_mode == "actual":
                selected_method = "actual"
                selected_gain = actual_gain
            elif method_mode == "deemed":
                selected_method = "deemed"
                selected_gain = deemed_gain
            else:
                # "auto_best_per_sale": for each SALE row, compare actual vs deemed
                # and choose the lower taxable gain/loss for that row.
                selected_method = "deemed" if deemed_gain < actual_gain else "actual"
                selected_gain = min(actual_gain, deemed_gain)

            row = {
                "sale_id": str(trade.get("trade_id") or f"{symbol}-{sell_date.isoformat()}-{trade_index}"),
                "symbol": symbol,
                "sell_date": sell_date.isoformat(),
                "sell_qty": round(matched_qty, 4),
                "proceeds": round(proceeds, 2),
                "actual_acquisition_cost": round(actual_acquisition_cost, 2),
                "transfer_tax": 0.0,
                "deductible_expenses": round(deductible_expenses, 2),
                "actual_taxable_gain_loss": round(actual_gain, 2),
                "deemed_rate_effective": round((deemed_cost / proceeds) if proceeds > 0 else 0.0, 4),
                "deemed_cost": round(deemed_cost, 2),
                "deemed_taxable_gain_loss": round(deemed_gain, 2),
                "selected_method": selected_method,
                "selected_taxable_gain_loss": round(selected_gain, 2),
                "avg_holding_years": round(avg_holding_years_weighted / matched_qty, 3),
            }
            trade_index += 1
            rows.append(row)

        return rows

    def calculate(
        self,
        request: TaxReportRequest,
        trades_df: pd.DataFrame,
        notes_df: pd.DataFrame,
        corporate_actions_df: pd.DataFrame,
    ) -> dict:
        del corporate_actions_df  # Finland v1 uses tradebook+contract-note charges only.
        method_mode = str(request.method_mode or "auto_best_per_sale").strip().lower()
        if method_mode not in {"actual", "deemed", "auto_best_per_sale"}:
            raise ValueError("method_mode must be one of: actual, deemed, auto_best_per_sale")

        clean_trades = self._sanitize_trades_df(trades_df)
        clean_notes = self._sanitize_notes_df(notes_df)
        if clean_trades.empty:
            return {
                "country_code": "FI",
                "country_name": "Finland",
                "tax_year": request.tax_year,
                "method_mode": method_mode,
                "formula_text": "Capital gain/loss is calculated per sale, then aggregated for calendar year.",
                "formula_lines": [
                    "Actual method: Selling price - (Acquisition cost + transfer tax + deductible expenses)",
                    "Deemed method: Selling price - (20% or 40% deemed acquisition cost)",
                ],
                "totals": {
                    "proceeds": 0.0,
                    "actual_gain_loss": 0.0,
                    "deemed_gain_loss": 0.0,
                    "selected_gain_loss_before_adjustments": 0.0,
                    "selected_gain_loss_after_adjustments": 0.0,
                    "estimated_tax": 0.0,
                },
                "flags": {
                    "small_sales_exemption_applied": False,
                    "loss_non_deductible_due_to_small_sales_rule": False,
                },
                "carryforward": {
                    "prior_loss_carryforward": round(float(request.prior_loss_carryforward or 0.0), 2),
                    "loss_used_this_year": 0.0,
                    "loss_to_carryforward_next_year": round(float(request.prior_loss_carryforward or 0.0), 2),
                },
                "disclaimer": "Estimate only. Use as a reporting aid and validate final values against official Vero instructions/forms for your filing year and edge cases.",
                "rows": [] if request.include_rows else None,
                "assumptions": [
                    "Finland tax year is calendar year.",
                    "No sales found for selected year.",
                ],
            }

        merged = self._apply_daily_charge_allocations(clean_trades, clean_notes)
        all_rows = self._calculate_rows(merged, request.tax_year, method_mode)
        rows = [r for r in all_rows if pd.to_datetime(r["sell_date"]).year == request.tax_year]

        total_proceeds = sum(float(r["proceeds"]) for r in rows)
        total_actual = sum(float(r["actual_taxable_gain_loss"]) for r in rows)
        total_deemed = sum(float(r["deemed_taxable_gain_loss"]) for r in rows)
        total_selected = sum(float(r["selected_taxable_gain_loss"]) for r in rows)

        small_sales_exemption_applied = total_proceeds <= 1000.0
        prior_loss = max(0.0, float(request.prior_loss_carryforward or 0.0))
        loss_used = 0.0
        loss_to_carry = prior_loss
        taxable_after_adjustments = total_selected
        estimated_tax = 0.0
        loss_non_deductible_due_to_small_sales_rule = False

        if small_sales_exemption_applied:
            taxable_after_adjustments = 0.0
            estimated_tax = 0.0
            if total_selected < 0:
                loss_non_deductible_due_to_small_sales_rule = True
        else:
            if taxable_after_adjustments > 0 and prior_loss > 0:
                loss_used = min(prior_loss, taxable_after_adjustments)
                taxable_after_adjustments -= loss_used
                loss_to_carry = prior_loss - loss_used
            elif taxable_after_adjustments <= 0:
                loss_to_carry = prior_loss + abs(taxable_after_adjustments)
            estimated_tax = self._tax_from_progressive_rate(taxable_after_adjustments)

        method_counts = {"actual": 0, "deemed": 0}
        for row in rows:
            method_counts[row["selected_method"]] = method_counts.get(row["selected_method"], 0) + 1

        return {
            "country_code": "FI",
            "country_name": "Finland",
            "tax_year": request.tax_year,
            "method_mode": method_mode,
            "formula_text": (
                "Actual method: Selling price - (Acquisition cost + transfer tax + deductible expenses)."
                "Deemed method: Selling price - (20% or 40% deemed acquisition cost)."
            ),
            "formula_lines": [
                "Actual method: Selling price - (Acquisition cost + transfer tax + deductible expenses)",
                "Deemed method: Selling price - (20% or 40% deemed acquisition cost)",
            ],
            "method_counts": method_counts,
            "totals": {
                "proceeds": round(total_proceeds, 2),
                "actual_gain_loss": round(total_actual, 2),
                "deemed_gain_loss": round(total_deemed, 2),
                "selected_gain_loss_before_adjustments": round(total_selected, 2),
                "selected_gain_loss_after_adjustments": round(taxable_after_adjustments, 2),
                "estimated_tax": round(estimated_tax, 2),
            },
            "flags": {
                "small_sales_exemption_applied": small_sales_exemption_applied,
                "loss_non_deductible_due_to_small_sales_rule": loss_non_deductible_due_to_small_sales_rule,
            },
            "carryforward": {
                "prior_loss_carryforward": round(prior_loss, 2),
                "loss_used_this_year": round(loss_used, 2),
                "loss_to_carryforward_next_year": round(max(0.0, loss_to_carry), 2),
            },
            "disclaimer": "Estimate only. Use as a reporting aid and validate final values against official Vero instructions/forms for your filing year and edge cases.",
            "rows": rows if request.include_rows else None,
            "assumptions": [
                "Finland tax year is calendar year.",
                "FIFO lot matching is used.",
                "Daily charges from contract notes are allocated by turnover across trades on the same date.",
                "Transfer tax is set to 0 unless provided separately in source data.",
                "Auto mode compares methods on each sale row and picks the lower taxable gain/loss for that row.",
            ],
        }
