from fastapi import FastAPI, UploadFile, File, Form, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import text
import pandas as pd
import yfinance as yf
import logging
import warnings
import time
import os
from datetime import datetime, date
import uuid
import math
from typing import Optional, List
from database import (
    SessionLocal,
    init_db,
    Trade,
    ContractNote,
    UploadBatch,
    ContractNoteTrade,
    ContractNoteCharge,
    SymbolAlias,
    CorporateAction,
)
from core import (
    parse_contract_note,
    parse_tradebook,
    calculate_fifo_holdings,
    calculate_realized_gains,
    detect_unmatched_sells,
    fy_label,
)
from tax import calculate_tax_report
from tax.registry import supported_countries
from tax.types import TaxReportRequest

app = FastAPI()

# Quiet noisy third-party logs/warnings (yfinance delisting/no-data chatter).
logging.getLogger("yfinance").setLevel(logging.ERROR)
warnings.filterwarnings("ignore", message=".*possibly delisted.*")
warnings.filterwarnings("ignore", message=".*No data found.*")

# Enable CORS for React Frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

def _user_log(message: str):
    print(f"🧾 {message}", flush=True)

@app.on_event("startup")
def on_startup():
    init_db()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Removed timing logs

# Simple in-memory cache for live prices to avoid repeated yfinance calls.
# Keyed by the requested symbols + their mapped tickers to stay consistent.
_PRICE_CACHE = {}
_PRICE_CACHE_TTL_SEC = 600
_INGEST_PROGRESS = {}

def _progress_update(progress_id: Optional[str], **fields):
    if not progress_id:
        return
    current = _INGEST_PROGRESS.get(progress_id, {})
    current.update(fields)
    current["updated_at"] = datetime.utcnow().isoformat()
    _INGEST_PROGRESS[progress_id] = current

def _fetch_yfinance_split_actions(symbol: str, start_date: date, end_date: date):
    actions = []
    errors = []

    for suffix in [".NS", ".BO"]:
        ticker = f"{symbol}{suffix}"
        try:
            t = yf.Ticker(ticker)
            splits = t.splits
            if splits is None or len(splits) == 0:
                continue
            for ts, ratio in splits.items():
                eff_date = pd.to_datetime(ts, errors="coerce").date()
                if eff_date is None or pd.isna(eff_date):
                    continue
                if eff_date < start_date or eff_date > end_date:
                    continue
                try:
                    ratio_val = float(ratio)
                except Exception:
                    continue
                if ratio_val <= 0 or abs(ratio_val - 1.0) < 1e-9:
                    continue
                actions.append({
                    "symbol": symbol,
                    "action_type": "SPLIT",
                    "effective_date": eff_date,
                    "ratio_from": 1.0,
                    "ratio_to": ratio_val,
                    "source": "YFINANCE",
                    "source_ref": ticker,
                })
        except Exception as e:
            errors.append(f"YFinance fetch failed for {ticker}: {str(e)}")

    # Deduplicate by (date, ratio) across NS/BO.
    uniq = {}
    for a in actions:
        key = (a["effective_date"], a["ratio_from"], a["ratio_to"])
        if key not in uniq:
            uniq[key] = a
    return list(uniq.values()), (None if not errors else "; ".join(errors[:4]))

def _sync_corporate_actions_for_symbols(db: Session, symbols: list[str], start_dates_by_symbol: dict[str, date]):
    synced = 0
    per_symbol = []
    warnings = []
    end_date = date.today()

    for symbol in sorted(set(symbols)):
        start_date = start_dates_by_symbol.get(symbol)
        if not start_date:
            _user_log(f"[CorpSync] {symbol}: skipped (no start date)")
            per_symbol.append({"symbol": symbol, "added": 0})
            continue

        yf_actions, yf_err = _fetch_yfinance_split_actions(symbol, start_date, end_date)
        _user_log(
            f"[CorpSync] {symbol}: range={start_date.isoformat()}..{end_date.isoformat()} "
            f"YF={len(yf_actions)}"
        )
        if yf_err:
            _user_log(f"[CorpSync] {symbol}: YF error: {yf_err}")
            warnings.append(yf_err)

        actions = yf_actions
        added = 0
        for a in actions:
            existing = db.query(CorporateAction).filter(
                CorporateAction.symbol == a["symbol"],
                CorporateAction.action_type == a["action_type"],
                CorporateAction.effective_date == a["effective_date"],
                CorporateAction.ratio_from == a["ratio_from"],
                CorporateAction.ratio_to == a["ratio_to"],
                CorporateAction.active == True,
            ).first()
            if existing:
                existing.source = a.get("source") or existing.source
                existing.source_ref = a.get("source_ref") or existing.source_ref
                existing.fetched_at = datetime.utcnow()
            else:
                db.add(CorporateAction(
                    symbol=a["symbol"],
                    action_type=a["action_type"],
                    effective_date=a["effective_date"],
                    ratio_from=a["ratio_from"],
                    ratio_to=a["ratio_to"],
                    source=a.get("source"),
                    source_ref=a.get("source_ref"),
                    fetched_at=datetime.utcnow(),
                    active=True,
                ))
                added += 1
        synced += added
        _user_log(f"[CorpSync] {symbol}: added_or_updated={added}")
        per_symbol.append({"symbol": symbol, "added": added})

    db.commit()
    _user_log(f"[CorpSync] done symbols={len(set(symbols))} total_added={synced}")
    return {
        "symbols_checked": len(set(symbols)),
        "actions_added": synced,
        "per_symbol": per_symbol,
        "warnings": warnings[:20],
    }

def _load_corporate_actions_df(db: Session):
    return pd.read_sql(
        db.query(CorporateAction).filter(CorporateAction.active == True).statement,
        db.bind
    )

def _to_fifo_trade_df(trades_df: pd.DataFrame):
    if trades_df is None or trades_df.empty:
        return pd.DataFrame(columns=["symbol", "date", "type", "quantity", "price"])
    df = trades_df.copy()
    if "date" not in df.columns and "trade_date" in df.columns:
        df["date"] = pd.to_datetime(df["trade_date"]).dt.date
    elif "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"]).dt.date
    if "type" not in df.columns and "trade_type" in df.columns:
        df["type"] = df["trade_type"]
    cols = ["symbol", "date", "type", "quantity", "price"]
    for c in cols:
        if c not in df.columns:
            df[c] = None
    return df[cols].copy()

def _log_split_impacts_for_preview(fifo_trades_df: pd.DataFrame, corporate_actions_df: pd.DataFrame):
    if fifo_trades_df is None or fifo_trades_df.empty:
        _user_log("[SplitCheck] No trades in preview.")
        return []
    if corporate_actions_df is None or corporate_actions_df.empty:
        _user_log("[SplitCheck] No corporate actions available in DB.")
        return []

    actions_df = corporate_actions_df.copy()
    actions_df["action_type"] = actions_df["action_type"].astype(str).str.upper()
    actions_df = actions_df[actions_df["action_type"] == "SPLIT"]
    if actions_df.empty:
        _user_log("[SplitCheck] No split actions available in DB.")
        return []

    actions_df["effective_date"] = pd.to_datetime(actions_df["effective_date"], errors="coerce").dt.date
    actions_df = actions_df[actions_df["effective_date"].notna()]
    actions_df["symbol"] = actions_df["symbol"].astype(str).str.upper()

    buys = fifo_trades_df[fifo_trades_df["type"].astype(str).str.upper() == "BUY"].copy()
    if buys.empty:
        _user_log("[SplitCheck] No BUY rows in preview.")
        return []

    buys["symbol"] = buys["symbol"].astype(str).str.upper()
    buys["date"] = pd.to_datetime(buys["date"], errors="coerce").dt.date
    first_buy_by_symbol = buys.groupby("symbol")["date"].min().to_dict()

    _user_log("[SplitCheck] ----- Split Impact Check (Preview) -----")
    empty_notes_df = pd.DataFrame(columns=["date"])
    any_logged = False
    impact_rows = []

    for symbol in sorted(first_buy_by_symbol.keys()):
        first_buy_date = first_buy_by_symbol[symbol]
        symbol_actions = actions_df[
            (actions_df["symbol"] == symbol) &
            (actions_df["effective_date"] >= first_buy_date)
        ].sort_values("effective_date")

        if symbol_actions.empty:
            _user_log(f"[SplitCheck] {symbol} first_buy={first_buy_date.isoformat()} split_count=0")
            continue

        symbol_trades = fifo_trades_df[fifo_trades_df["symbol"].astype(str).str.upper() == symbol].copy()
        if symbol_trades.empty:
            continue

        _user_log(f"[SplitCheck] {symbol} first_buy={first_buy_date.isoformat()} split_count={len(symbol_actions)}")
        for _, action in symbol_actions.iterrows():
            eff = action["effective_date"]
            r_from = action.get("ratio_from")
            r_to = action.get("ratio_to")
            if r_from is None or r_to is None:
                _user_log(f"[SplitCheck]   {symbol} split={eff.isoformat()} ratio=unknown (skipped)")
                continue
            try:
                r_from = float(r_from)
                r_to = float(r_to)
            except Exception:
                _user_log(f"[SplitCheck]   {symbol} split={eff.isoformat()} ratio_invalid={r_from}:{r_to} (skipped)")
                continue
            if r_from <= 0 or r_to <= 0:
                _user_log(f"[SplitCheck]   {symbol} split={eff.isoformat()} ratio_non_positive={r_from}:{r_to} (skipped)")
                continue

            prior_actions = symbol_actions[symbol_actions["effective_date"] < eff]
            holdings_before = calculate_fifo_holdings(
                symbol_trades,
                empty_notes_df,
                up_to_date=eff,
                corporate_actions_df=prior_actions,
            )
            lots = holdings_before.get(symbol, [])
            qty_before = float(sum(l.get("qty", 0.0) for l in lots))
            factor = r_to / r_from
            qty_after = qty_before * factor
            delta = qty_after - qty_before
            _user_log(
                f"[SplitCheck]   split={eff.isoformat()} ratio={r_from:g}:{r_to:g} "
                f"affected_qty={qty_before:.4f} -> {qty_after:.4f} (delta={delta:+.4f})"
            )
            impact_rows.append({
                "symbol": symbol,
                "first_buy_date": first_buy_date.isoformat(),
                "split_date": eff.isoformat(),
                "ratio_from": r_from,
                "ratio_to": r_to,
                "qty_before": round(qty_before, 4),
                "qty_after": round(qty_after, 4),
                "delta_qty": round(delta, 4),
                "source": action.get("source"),
                "source_ref": action.get("source_ref"),
            })
            any_logged = True

    if not any_logged:
        _user_log("[SplitCheck] No splits found after first BUY date for preview symbols.")
    _user_log("[SplitCheck] ----------------------------------------")
    return impact_rows

# --- ENDPOINTS ---

@app.post("/ingest/preview")
async def ingest_preview(
    progress_id: Optional[str] = Form(None),
    tradebook: Optional[UploadFile] = File(None),
    tradebooks: Optional[List[UploadFile]] = File(None),
    contracts: Optional[List[UploadFile]] = File(None),
    db: Session = Depends(get_db)
):
    try:
        # Collect selected tradebooks early so progress can include total file count.
        selected_tradebooks = []
        if tradebooks:
            selected_tradebooks.extend(tradebooks)
        if tradebook is not None:
            selected_tradebooks.append(tradebook)
        if not selected_tradebooks:
            raise HTTPException(status_code=400, detail="At least one tradebook CSV is required.")

        total_files = len(selected_tradebooks) + len(contracts or [])
        processed_files = 0.0
        _progress_update(
            progress_id,
            status="running",
            stage="starting",
            message="Starting preview generation...",
            total_files=total_files,
            processed_files=processed_files,
            left_files=max(total_files - processed_files, 0),
        )

        # 1) Parse contract notes
        errors = []
        if not contracts:
            errors.append(
                "Tradebook uploaded without contract notes. Charges cannot be computed correctly because tradebook does not contain detailed charge data."
            )
        note_map = {}
        contract_trade_rows = []
        contract_charge_rows = []

        def _clean_number(val, default_zero=False):
            if val is None:
                return 0.0 if default_zero else None
            if isinstance(val, str) and val.strip().lower() == "nan":
                return 0.0 if default_zero else None
            if pd.isna(val):
                return 0.0 if default_zero else None
            try:
                f_val = float(val)
            except Exception:
                return 0.0 if default_zero else None
            if not math.isfinite(f_val):
                return 0.0 if default_zero else None
            return f_val

        for cf in (contracts or []):
            completed_before = processed_files
            try:
                _progress_update(
                    progress_id,
                    stage="contracts",
                    message=f"Parsing contract notes: {cf.filename}",
                    total_files=total_files,
                    processed_files=processed_files,
                    left_files=max(total_files - processed_files, 0),
                )
                content = await cf.read()

                def _sheet_progress(done_sheets: int, total_sheets: int, sheet_name: str):
                    total = max(int(total_sheets or 1), 1)
                    done = max(min(int(done_sheets or 0), total), 0)
                    # Keep 5% reserved for finalization so users can see in-file progress.
                    in_file_ratio = (done / total) * 0.95
                    in_file_progress = completed_before + in_file_ratio
                    _progress_update(
                        progress_id,
                        stage="contracts",
                        message=f"Parsing {cf.filename} ({done}/{total} sheets)",
                        total_files=total_files,
                        processed_files=round(in_file_progress, 3),
                        left_files=max(total_files - in_file_progress, 0),
                    )

                parsed_list = parse_contract_note(content, progress_cb=_sheet_progress)
                if parsed_list:
                    for data in parsed_list:
                        for warn in data.get("warnings", []):
                            errors.append(f"{cf.filename} [{data.get('sheet_name', 'Sheet')}]: {warn}")

                        note_date = data["trade_date"]
                        charges = data.get("charges", {}) or {}
                        charges_debug = data.get("charges_debug", {}) or {}

                        total_brokerage = abs(charges.get("taxable_value_of_supply") or 0)
                        total_taxes = abs(sum([
                            charges.get("cgst") or 0,
                            charges.get("sgst") or 0,
                            charges.get("igst") or 0,
                            charges.get("stt") or 0,
                        ]))
                        total_other = abs(sum([
                            charges.get("exchange_txn_charges") or 0,
                            charges.get("clearing_charges") or 0,
                            charges.get("sebi_txn_tax") or 0,
                            charges.get("stamp_duty") or 0,
                        ]))
                        net_total = abs(charges.get("net_amount_receivable") or 0)

                        daily = {
                            "date": note_date,
                            "total_brokerage": total_brokerage,
                            "total_taxes": total_taxes,
                            "total_other_charges": total_other,
                            "net_total_paid": net_total,
                        }

                        if note_date in note_map:
                            note_map[note_date]["total_brokerage"] += daily["total_brokerage"] or 0
                            note_map[note_date]["total_taxes"] += daily["total_taxes"] or 0
                            note_map[note_date]["total_other_charges"] += daily["total_other_charges"] or 0
                            note_map[note_date]["net_total_paid"] += daily["net_total_paid"] or 0
                        else:
                            note_map[note_date] = daily

                    for data in parsed_list:
                        sheet_name = data.get("sheet_name")
                        trade_date = data.get("trade_date")
                        contract_note_no = data.get("contract_note_no")
                        if not contract_note_no:
                            errors.append(f"{cf.filename} [{sheet_name or 'Sheet'}]: missing Contract Note No")

                        for t in data.get("trades", []):
                            contract_trade_rows.append({
                                "contract_note_no": contract_note_no,
                                "trade_date": trade_date.isoformat() if trade_date else None,
                                "order_no": t.get("order_no"),
                                "order_time": t.get("order_time"),
                                "trade_no": t.get("trade_no"),
                                "trade_time": t.get("trade_time"),
                                "security_desc": t.get("security_desc"),
                                "side": t.get("side"),
                                "quantity": _clean_number(t.get("quantity")),
                                "exchange": t.get("exchange"),
                                "gross_rate": _clean_number(t.get("gross_rate")),
                                "net_total": _clean_number(t.get("net_total")),
                                "sheet_name": sheet_name,
                                "file_name": cf.filename,
                            })

                        charges = data.get("charges", {}) or {}
                        charge_row = {
                            "contract_note_no": contract_note_no,
                            "trade_date": trade_date.isoformat() if trade_date else None,
                            "pay_in_out_obligation": _clean_number(charges.get("pay_in_out_obligation")),
                            "taxable_value_of_supply": _clean_number(charges.get("taxable_value_of_supply")),
                            "brokerage": _clean_number(charges.get("taxable_value_of_supply")),
                            "exchange_txn_charges": _clean_number(charges.get("exchange_txn_charges")),
                            "clearing_charges": _clean_number(charges.get("clearing_charges")),
                            "cgst": _clean_number(charges.get("cgst")),
                            "sgst": _clean_number(charges.get("sgst")),
                            "igst": _clean_number(charges.get("igst")),
                            "stt": _clean_number(charges.get("stt")),
                            "sebi_txn_tax": _clean_number(charges.get("sebi_txn_tax")),
                            "sebi_turnover_fees": _clean_number(charges.get("sebi_txn_tax")),
                            "stamp_duty": _clean_number(charges.get("stamp_duty")),
                            "net_amount_receivable": _clean_number(charges.get("net_amount_receivable")),
                            "sheet_name": sheet_name,
                            "file_name": cf.filename,
                            "debug": charges_debug,
                        }
                        contract_charge_rows.append(charge_row)

                        net_amount = charge_row.get("net_amount_receivable")
                        if net_amount is not None:
                            calc_total = (
                                (charge_row.get("pay_in_out_obligation") or 0.0)
                                + (charge_row.get("brokerage") or 0.0)
                                + (charge_row.get("exchange_txn_charges") or 0.0)
                                + (charge_row.get("clearing_charges") or 0.0)
                                + (charge_row.get("cgst") or 0.0)
                                + (charge_row.get("sgst") or 0.0)
                                + (charge_row.get("igst") or 0.0)
                                + (charge_row.get("stt") or 0.0)
                                + (charge_row.get("sebi_turnover_fees") or charge_row.get("sebi_txn_tax") or 0.0)
                                + (charge_row.get("stamp_duty") or 0.0)
                            )
                            if abs(calc_total - net_amount) > 0.01:
                                note_label = contract_note_no or sheet_name or cf.filename
                                _user_log(
                                    "Charge calculation mismatch: "
                                    f"{note_label} "
                                    f"calc={calc_total:.4f} net={net_amount:.4f} "
                                    f"diff={(calc_total - net_amount):.4f}"
                                )
                else:
                    errors.append(f"Could not parse {cf.filename} (Format issue?)")
            except Exception as e:
                errors.append(f"Error reading {cf.filename}: {str(e)}")
            finally:
                processed_files += 1
                _progress_update(
                    progress_id,
                    stage="contracts",
                    message="Contract notes parsed.",
                    total_files=total_files,
                    processed_files=processed_files,
                    left_files=max(total_files - processed_files, 0),
                )

        # 2) Parse tradebook(s) (required)
        trades_df_list = []
        tradebook_filenames = []
        for tb in selected_tradebooks:
            completed_before = processed_files
            _progress_update(
                progress_id,
                stage="tradebooks",
                message=f"Parsing tradebook: {tb.filename}",
                total_files=total_files,
                processed_files=round(completed_before + 0.15, 3),
                left_files=max(total_files - (completed_before + 0.15), 0),
            )
            tb_content = await tb.read()
            try:
                one_df = parse_tradebook(tb_content)
                _progress_update(
                    progress_id,
                    stage="tradebooks",
                    message=f"Validating tradebook rows: {tb.filename}",
                    total_files=total_files,
                    processed_files=round(completed_before + 0.85, 3),
                    left_files=max(total_files - (completed_before + 0.85), 0),
                )
                trades_df_list.append(one_df)
                tradebook_filenames.append(tb.filename)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=f"{tb.filename}: {str(e)}")
            finally:
                processed_files += 1
                _progress_update(
                    progress_id,
                    stage="tradebooks",
                    message="Tradebooks parsed.",
                    total_files=total_files,
                    processed_files=processed_files,
                    left_files=max(total_files - processed_files, 0),
                )

        trades_df = pd.concat(trades_df_list, ignore_index=True)
        before_dedupe = len(trades_df)
        trades_df = trades_df.sort_values("trade_date").drop_duplicates(subset=["trade_id"], keep="last")
        dropped_rows = before_dedupe - len(trades_df)
        if dropped_rows > 0:
            errors.append(f"Skipped {dropped_rows} duplicate trade rows by trade_id from uploaded tradebook files.")

        alias_map = _load_symbol_alias_map(db)
        symbol_buy_start_dates = {}
        buy_df = trades_df[trades_df["trade_type"] == "BUY"]
        if not buy_df.empty:
            for symbol, grp in buy_df.groupby("symbol"):
                norm_symbol = _resolve_alias_symbol(symbol, alias_map)
                min_date = grp["trade_date"].min()
                if norm_symbol not in symbol_buy_start_dates or min_date < symbol_buy_start_dates[norm_symbol]:
                    symbol_buy_start_dates[norm_symbol] = min_date

        corp_sync = _sync_corporate_actions_for_symbols(
            db=db,
            symbols=list(symbol_buy_start_dates.keys()),
            start_dates_by_symbol=symbol_buy_start_dates,
        )
        preview_fifo_df = _to_fifo_trade_df(trades_df)
        preview_fifo_df = _apply_aliases_to_trades_df(preview_fifo_df, alias_map)
        corporate_actions_df = _load_corporate_actions_df(db)
        split_impact_rows = _log_split_impacts_for_preview(preview_fifo_df, corporate_actions_df)
        if corp_sync.get("warnings"):
            errors.extend(corp_sync["warnings"])

        # 3) Prepare JSON payloads
        trade_rows = []
        for _, row in trades_df.iterrows():
            trade_rows.append({
                "trade_id": str(row["trade_id"]),
                "symbol": row["symbol"],
                "isin": row.get("isin", ""),
                "date": row["trade_date"].isoformat(),
                "type": row["trade_type"],
                "quantity": float(row["quantity"]),
                "price": float(row["price"]),
                "gross_amount": float(row["gross_amount"]),
            })

        contract_rows = []
        for note_date, data in note_map.items():
            contract_rows.append({
                "date": note_date.isoformat(),
                "total_brokerage": _clean_number(data["total_brokerage"], default_zero=True),
                "total_taxes": _clean_number(data["total_taxes"], default_zero=True),
                "total_other_charges": _clean_number(data["total_other_charges"], default_zero=True),
                "net_total_paid": _clean_number(data["net_total_paid"], default_zero=True),
            })

        trade_dates = {row["date"] for row in trade_rows}
        note_dates = {row["date"] for row in contract_rows}
        missing_dates = sorted([d for d in trade_dates if d not in note_dates])

        summary = {
            "trades_count": len(trade_rows),
            "tradebooks_count": len(tradebook_filenames),
            "contract_notes_count": len(contract_rows),
            "contract_trade_rows_count": len(contract_trade_rows),
            "contract_charge_rows_count": len(contract_charge_rows),
            "parsed_sheets_count": len(contract_charge_rows),
            "corporate_actions_sync": corp_sync,
            "split_impact_count": len(split_impact_rows),
            "missing_contract_note_dates": missing_dates,
            "warnings": errors,
        }

        batch_id = str(uuid.uuid4())
        batch = UploadBatch(
            id=batch_id,
            created_at=datetime.utcnow(),
            is_committed=False,
            tradebook_filename=", ".join(tradebook_filenames),
            contract_filenames=[c.filename for c in (contracts or [])],
            trade_rows=trade_rows,
            contract_rows=contract_rows,
            contract_trade_rows=contract_trade_rows,
            contract_charge_rows=contract_charge_rows,
            summary=summary,
        )
        db.add(batch)
        db.commit()

        _progress_update(
            progress_id,
            status="done",
            stage="complete",
            message="Preview ready.",
            total_files=total_files,
            processed_files=total_files,
            left_files=0,
        )

        return {
            "staging_id": batch_id,
            "summary": summary,
            "trade_rows_preview": trade_rows,
            "contract_rows_preview": contract_rows,
            "contract_trade_rows_preview": contract_trade_rows,
            "contract_charge_rows_preview": contract_charge_rows,
            "split_impact_rows_preview": split_impact_rows[:200],
        }
    except HTTPException as he:
        _progress_update(
            progress_id,
            status="error",
            stage="error",
            message=str(he.detail),
        )
        raise he
    except Exception as e:
        _user_log(f"Preview Error: {e}")
        _progress_update(
            progress_id,
            status="error",
            stage="error",
            message=str(e),
        )
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/ingest/progress/{progress_id}")
def ingest_progress(progress_id: str):
    row = _INGEST_PROGRESS.get(progress_id)
    if not row:
        raise HTTPException(status_code=404, detail="Progress id not found")
    return row

@app.post("/ingest/commit")
def ingest_commit(payload: dict, db: Session = Depends(get_db)):
    try:
        staging_id = payload.get("staging_id")
        if not staging_id:
            raise HTTPException(status_code=400, detail="staging_id is required.")

        batch = db.query(UploadBatch).filter(UploadBatch.id == staging_id).first()
        if not batch:
            raise HTTPException(status_code=404, detail="Staging batch not found.")
        if batch.is_committed:
            raise HTTPException(status_code=400, detail="This staging batch is already committed.")

        # Upsert Contract Notes (daily summaries)
        for row in batch.contract_rows or []:
            note = ContractNote(
                date=pd.to_datetime(row["date"]).date(),
                total_brokerage=row["total_brokerage"],
                total_taxes=row["total_taxes"],
                total_other_charges=row["total_other_charges"],
                net_total_paid=row["net_total_paid"],
            )
            db.merge(note)

        # Remove existing contract note rows for same file/date to prevent duplicates
        trade_dates = set()
        file_names = set()
        for row in batch.contract_trade_rows or []:
            if row.get("trade_date"):
                trade_dates.add(pd.to_datetime(row["trade_date"]).date())
            if row.get("file_name"):
                file_names.add(row.get("file_name"))

        if trade_dates and file_names:
            db.query(ContractNoteTrade).filter(
                ContractNoteTrade.trade_date.in_(trade_dates),
                ContractNoteTrade.file_name.in_(file_names)
            ).delete(synchronize_session=False)
            db.query(ContractNoteCharge).filter(
                ContractNoteCharge.trade_date.in_(trade_dates),
                ContractNoteCharge.file_name.in_(file_names)
            ).delete(synchronize_session=False)

        # Insert Contract Note Trades
        for row in batch.contract_trade_rows or []:
            db.add(ContractNoteTrade(
                contract_note_no=row.get("contract_note_no"),
                trade_date=pd.to_datetime(row["trade_date"]).date() if row.get("trade_date") else None,
                order_no=row.get("order_no"),
                order_time=row.get("order_time"),
                trade_no=row.get("trade_no"),
                trade_time=row.get("trade_time"),
                security_desc=row.get("security_desc"),
                side=row.get("side"),
                quantity=row.get("quantity"),
                exchange=row.get("exchange"),
                gross_rate=row.get("gross_rate"),
                net_total=row.get("net_total"),
                sheet_name=row.get("sheet_name"),
                file_name=row.get("file_name"),
            ))

        # Insert Contract Note Charges
        for row in batch.contract_charge_rows or []:
            db.add(ContractNoteCharge(
                contract_note_no=row.get("contract_note_no"),
                trade_date=pd.to_datetime(row["trade_date"]).date() if row.get("trade_date") else None,
                pay_in_out_obligation=row.get("pay_in_out_obligation"),
                taxable_value_of_supply=row.get("brokerage") if row.get("brokerage") is not None else row.get("taxable_value_of_supply"),
                exchange_txn_charges=row.get("exchange_txn_charges"),
                clearing_charges=row.get("clearing_charges"),
                cgst=row.get("cgst"),
                sgst=row.get("sgst"),
                igst=row.get("igst"),
                stt=row.get("stt"),
                sebi_txn_tax=row.get("sebi_turnover_fees") if row.get("sebi_turnover_fees") is not None else row.get("sebi_txn_tax"),
                stamp_duty=row.get("stamp_duty"),
                net_amount_receivable=row.get("net_amount_receivable"),
                sheet_name=row.get("sheet_name"),
                file_name=row.get("file_name"),
            ))

        # Upsert Trades
        for row in batch.trade_rows or []:
            existing = db.query(Trade).filter(Trade.trade_id == row["trade_id"]).first()
            if existing:
                existing.symbol = row["symbol"]
                existing.isin = row.get("isin", "")
                existing.date = pd.to_datetime(row["date"]).date()
                existing.type = row["type"]
                existing.quantity = row["quantity"]
                existing.price = row["price"]
                existing.gross_amount = row["gross_amount"]
            else:
                db.add(Trade(
                    trade_id=row["trade_id"],
                    symbol=row["symbol"],
                    isin=row.get("isin", ""),
                    date=pd.to_datetime(row["date"]).date(),
                    type=row["type"],
                    quantity=row["quantity"],
                    price=row["price"],
                    gross_amount=row["gross_amount"],
                ))

        batch.is_committed = True
        batch.committed_at = datetime.utcnow()
        db.commit()

        return {"message": "Ingestion committed successfully."}
    except HTTPException as he:
        raise he
    except Exception as e:
        db.rollback()
        _user_log(f"Commit Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/fy-list")
def get_fy_list(db: Session = Depends(get_db)):
    trades_df = pd.read_sql(db.query(Trade).statement, db.bind)
    if trades_df.empty:
        return {"fy_list": []}
    fy_set = {fy_label(d) for d in trades_df['date']}
    return {"fy_list": sorted(fy_set)}

def _fy_end_date(fy: str):
    if not fy.startswith("FY"):
        raise ValueError("FY must be like FY2025")
    year = int(fy.replace("FY", ""))
    return date(year, 3, 31)

def _fy_start_date(fy: str):
    if not fy.startswith("FY"):
        raise ValueError("FY must be like FY2025")
    year = int(fy.replace("FY", ""))
    return date(year - 1, 4, 1)

def _load_symbol_alias_map(db: Session):
    rows = db.query(SymbolAlias).filter(SymbolAlias.active == True).all()
    return {r.from_symbol: r.to_symbol for r in rows}

def _resolve_alias_symbol(symbol: str, alias_map: dict[str, str]):
    curr = (symbol or "").strip().upper()
    visited = set()
    while curr in alias_map and curr not in visited:
        visited.add(curr)
        nxt = (alias_map.get(curr) or "").strip().upper()
        if not nxt:
            break
        curr = nxt
    return curr

def _apply_aliases_to_trades_df(trades_df: pd.DataFrame, alias_map: dict[str, str]):
    if trades_df.empty or "symbol" not in trades_df.columns:
        return trades_df
    df = trades_df.copy()
    df["symbol"] = df["symbol"].astype(str).map(lambda s: _resolve_alias_symbol(s, alias_map))
    return df

def _resolve_latest_prices(symbols: list[str], alias_map: dict[str, str]):
    if not symbols:
        return {}, []
    mapped = {s: _resolve_alias_symbol(s, alias_map) for s in symbols}
    tickers = [mapped[s] + ".NS" for s in symbols]
    live_prices = {}
    missing_symbols = []

    # Cache key includes symbol->ticker mapping to keep results consistent.
    cache_key = tuple(sorted(f"{s}:{mapped[s]}" for s in symbols))
    now = time.time()
    cached = _PRICE_CACHE.get(cache_key)
    if cached and (now - cached["ts"] <= _PRICE_CACHE_TTL_SEC):
        return cached["live_prices"], cached["missing_symbols"]

    def _last_valid(series: pd.Series):
        if series is None:
            return None
        series = series.dropna()
        if series.empty:
            return None
        return series.iloc[-1]

    data = yf.download(tickers, period="5d", progress=False)['Close']
    if len(symbols) == 1:
        series = data if isinstance(data, pd.Series) else data.iloc[:, 0]
        val = _last_valid(series)
        if val is not None and pd.notnull(val):
            live_prices[symbols[0]] = val
        else:
            missing_symbols.append({"symbol": symbols[0], "attempted": mapped[symbols[0]]})
    else:
        for s in symbols:
            col = mapped[s] + ".NS"
            series = data[col] if col in data else None
            val = _last_valid(series) if series is not None else None
            if val is not None and pd.notnull(val):
                live_prices[s] = val
            else:
                missing_symbols.append({"symbol": s, "attempted": mapped[s]})

    # Store in-memory cache to reuse across dashboard + summary requests.
    _PRICE_CACHE[cache_key] = {
        "ts": now,
        "live_prices": live_prices,
        "missing_symbols": missing_symbols,
    }
    return live_prices, missing_symbols

@app.post("/symbols/aliases")
def upsert_symbol_aliases(payload: dict, db: Session = Depends(get_db)):
    items = payload.get("aliases", [])
    if not isinstance(items, list):
        raise HTTPException(status_code=400, detail="aliases must be a list.")
    for item in items:
        from_symbol = (item.get("from_symbol") or "").strip().upper()
        to_symbol = (item.get("to_symbol") or "").strip().upper()
        if not from_symbol or not to_symbol:
            continue
        existing = db.query(SymbolAlias).filter(SymbolAlias.from_symbol == from_symbol).first()
        if existing:
            existing.to_symbol = to_symbol
            existing.active = True
        else:
            db.add(SymbolAlias(from_symbol=from_symbol, to_symbol=to_symbol, active=True))
    db.commit()
    return {"message": "Aliases updated."}

@app.get("/symbols/aliases")
def list_symbol_aliases(db: Session = Depends(get_db)):
    rows = db.query(SymbolAlias).filter(SymbolAlias.active == True).all()
    return {"aliases": [{"from_symbol": r.from_symbol, "to_symbol": r.to_symbol} for r in rows]}

@app.get("/dashboard")
def get_dashboard(fy: str, db: Session = Depends(get_db)):
    try:
        # 1. Load Data
        trades_df = pd.read_sql(db.query(Trade).statement, db.bind)
        notes_df = pd.read_sql(db.query(ContractNote).statement, db.bind)
        corporate_actions_df = _load_corporate_actions_df(db)
        alias_map = _load_symbol_alias_map(db)
        trades_df = _apply_aliases_to_trades_df(trades_df, alias_map)

        if trades_df.empty:
            return {
                "fy": fy,
                "fy_list": [],
                "holdings": [],
                "health_issues": [],
                "data_warnings": [],
                "realized_pnl": 0.0,
                "net_worth": 0.0,
                "net_worth_yoy": 0.0,
            }

        # 2. Health Check
        unique_trade_dates = set(trades_df['date'])
        unique_note_dates = set(notes_df['date'])
        missing_dates = sorted([str(d) for d in unique_trade_dates if d not in unique_note_dates])

        # 3. Logic
        holdings_dict = calculate_fifo_holdings(trades_df, notes_df, corporate_actions_df=corporate_actions_df)

        # 4. Live Data
        active_symbols = [s for s, batches in holdings_dict.items() if sum(b['qty'] for b in batches) > 0.01]
        live_prices = {}
        missing_symbols = []
        
        if active_symbols:
            try:
                live_prices, missing_symbols = _resolve_latest_prices(active_symbols, alias_map)
            except Exception as e:
                _user_log(f"YFinance Error: {e}")
                missing_symbols = [{"symbol": s, "attempted": alias_map.get(s, s)} for s in active_symbols]

        # 5. Build Holdings Response
        result = []
        for sym, batches in holdings_dict.items():
            qty = sum(b['qty'] for b in batches)
            if qty > 0.01:
                avg_price = abs(sum(b['qty'] * b['price'] for b in batches) / qty)
                cmp = live_prices.get(sym, avg_price)
                
                result.append({
                    "symbol": sym,
                    "quantity": round(qty, 2),
                    "avg_price": round(avg_price, 2),
                    "cmp": round(cmp, 2),
                    "current_val": round(qty * cmp, 2),
                    "invested_val": round(qty * avg_price, 2),
                    "pnl": round((qty * cmp) - (qty * avg_price), 2),
                    "pnl_pct": round(((cmp - avg_price) / avg_price) * 100, 2) if avg_price > 0 else 0
                })

        # 6. FY Summary (Realized P&L)
        realized = calculate_realized_gains(trades_df, notes_df, corporate_actions_df=corporate_actions_df)
        unmatched_sells = detect_unmatched_sells(trades_df)
        realized_total = 0.0
        for row in realized:
            if fy_label(row["sell_date"]) == fy:
                realized_total += row["realized_pnl"]

        fy_unmatched = [
            {
                "symbol": row["symbol"],
                "sell_date": row["sell_date"].isoformat(),
                "sell_qty": row["sell_qty"],
                "unmatched_qty": row["unmatched_qty"],
            }
            for row in unmatched_sells
            if fy_label(row["sell_date"]) == fy
        ]

        # 7. Net Worth (estimated with latest prices)
        net_worth = sum(h["current_val"] for h in result)

        fy_end = _fy_end_date(fy)
        prev_fy_end = date(fy_end.year - 1, 3, 31)

        holdings_fy = calculate_fifo_holdings(trades_df, notes_df, up_to_date=fy_end, corporate_actions_df=corporate_actions_df)
        holdings_prev = calculate_fifo_holdings(trades_df, notes_df, up_to_date=prev_fy_end, corporate_actions_df=corporate_actions_df)

        def _value(holdings_map):
            total = 0.0
            for sym, batches in holdings_map.items():
                qty = sum(b['qty'] for b in batches)
                if qty > 0.01:
                    cmp = live_prices.get(sym)
                    if cmp is None:
                        avg_price = sum(b['qty'] * b['price'] for b in batches) / qty
                        cmp = avg_price
                    total += qty * cmp
            return total

        net_worth_fy = _value(holdings_fy)
        net_worth_prev = _value(holdings_prev)
        net_worth_yoy = net_worth_fy - net_worth_prev

        fy_set = {fy_label(d) for d in trades_df['date']}

        return {
            "fy": fy,
            "fy_list": sorted(fy_set),
            "holdings": result,
            "health_issues": missing_dates,
            "data_warnings": {
                "unmatched_sells": fy_unmatched,
            },
            "realized_pnl": round(realized_total, 2),
            "net_worth": round(net_worth, 2),
            "net_worth_yoy": round(net_worth_yoy, 2),
            "missing_symbols": missing_symbols,
            "symbol_aliases": alias_map,
        }
    except Exception as e:
        _user_log(f"Portfolio Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/reports/summary")
def get_report_summary(db: Session = Depends(get_db)):
    try:
        trades_df = pd.read_sql(db.query(Trade).statement, db.bind)
        charges_df = pd.read_sql(db.query(ContractNoteCharge).statement, db.bind)
        notes_df = pd.read_sql(db.query(ContractNote).statement, db.bind)
        corporate_actions_df = _load_corporate_actions_df(db)
        alias_map = _load_symbol_alias_map(db)
        trades_df = _apply_aliases_to_trades_df(trades_df, alias_map)

        if trades_df.empty:
            return {"networth_by_fy": [], "charges_by_fy": []}

        fy_set = sorted({fy_label(d) for d in trades_df['date']})

        # Live prices for current holdings symbols
        holdings_dict = calculate_fifo_holdings(trades_df, notes_df, corporate_actions_df=corporate_actions_df)
        active_symbols = [s for s, batches in holdings_dict.items() if sum(b['qty'] for b in batches) > 0.01]
        live_prices = {}
        if active_symbols:
            try:
                live_prices, _ = _resolve_latest_prices(active_symbols, alias_map)
            except Exception as e:
                _user_log(f"YFinance Error: {e}")

        networth_by_fy = []
        for fy in fy_set:
            fy_end = _fy_end_date(fy)
            holdings_fy = calculate_fifo_holdings(trades_df, notes_df, up_to_date=fy_end, corporate_actions_df=corporate_actions_df)
            total = 0.0
            for sym, batches in holdings_fy.items():
                qty = sum(b['qty'] for b in batches)
                if qty > 0.01:
                    cmp = live_prices.get(sym)
                    if cmp is None:
                        avg_price = sum(b['qty'] * b['price'] for b in batches) / qty
                        cmp = avg_price
                    total += qty * cmp
            networth_by_fy.append({"fy": fy, "networth": round(total, 2)})

        charges_by_fy = []
        if not charges_df.empty:
            charges_df['trade_date'] = pd.to_datetime(charges_df['trade_date']).dt.date
            for fy in fy_set:
                fy_start = _fy_start_date(fy)
                fy_end = _fy_end_date(fy)
                mask = (charges_df['trade_date'] >= fy_start) & (charges_df['trade_date'] <= fy_end)
                subset = charges_df[mask]
                if subset.empty:
                    charges_by_fy.append({"fy": fy, "charges": 0.0})
                else:
                    charges_total = (
                        subset['exchange_txn_charges'].fillna(0).sum() +
                        subset['clearing_charges'].fillna(0).sum() +
                        subset['cgst'].fillna(0).sum() +
                        subset['sgst'].fillna(0).sum() +
                        subset['igst'].fillna(0).sum() +
                        subset['stt'].fillna(0).sum() +
                        subset['sebi_txn_tax'].fillna(0).sum() +
                        subset['stamp_duty'].fillna(0).sum()
                    )
                    charges_by_fy.append({"fy": fy, "charges": round(float(charges_total), 2)})
        else:
            charges_by_fy = [{"fy": fy, "charges": 0.0} for fy in fy_set]

        return {"networth_by_fy": networth_by_fy, "charges_by_fy": charges_by_fy}
    except Exception as e:
        _user_log(f"Report Summary Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/reports/realized")
def get_report_realized(fy: Optional[str] = None, db: Session = Depends(get_db)):
    try:
        trades_df = pd.read_sql(db.query(Trade).statement, db.bind)
        notes_df = pd.read_sql(db.query(ContractNote).statement, db.bind)
        corporate_actions_df = _load_corporate_actions_df(db)
        alias_map = _load_symbol_alias_map(db)
        trades_df = _apply_aliases_to_trades_df(trades_df, alias_map)
        if trades_df.empty:
            return {"fy": fy, "rows": []}

        realized = calculate_realized_gains(trades_df, notes_df, corporate_actions_df=corporate_actions_df)
        rows = []
        for r in realized:
            if fy is None or fy_label(r["sell_date"]) == fy:
                rows.append({
                    "symbol": r["symbol"],
                    "sell_date": r["sell_date"].isoformat(),
                    "sell_qty": float(r["sell_qty"]),
                    "sell_price": round(float(r["sell_price"]), 4),
                    "avg_buy_price": round(float(r["avg_buy_price"]), 4),
                    "realized_pnl": round(float(r["realized_pnl"]), 2),
                })
        return {"fy": fy, "rows": rows}
    except Exception as e:
        _user_log(f"Report Realized Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/tax/countries")
def get_tax_supported_countries():
    return {"countries": supported_countries()}


@app.post("/tax/report")
def post_tax_report(payload: dict, db: Session = Depends(get_db)):
    try:
        country_code = str(payload.get("country_code") or "").upper()
        tax_year_raw = payload.get("tax_year")
        if not country_code:
            raise HTTPException(status_code=400, detail="country_code is required")
        if tax_year_raw is None:
            raise HTTPException(status_code=400, detail="tax_year is required")
        try:
            tax_year = int(tax_year_raw)
        except Exception:
            raise HTTPException(status_code=400, detail="tax_year must be an integer")
        if tax_year < 1900 or tax_year > 2100:
            raise HTTPException(status_code=400, detail="tax_year must be between 1900 and 2100")

        req = TaxReportRequest(
            country_code=country_code,
            tax_year=tax_year,
            method_mode=str(payload.get("method_mode") or "auto_best_per_sale"),
            prior_loss_carryforward=float(payload.get("prior_loss_carryforward") or 0.0),
            include_rows=bool(payload.get("include_rows", True)),
            base_currency=str(payload.get("base_currency") or "EUR"),
        )

        trades_df = pd.read_sql(db.query(Trade).statement, db.bind)
        notes_df = pd.read_sql(db.query(ContractNote).statement, db.bind)
        corporate_actions_df = _load_corporate_actions_df(db)
        alias_map = _load_symbol_alias_map(db)
        trades_df = _apply_aliases_to_trades_df(trades_df, alias_map)

        result = calculate_tax_report(
            request=req,
            trades_df=trades_df,
            notes_df=notes_df,
            corporate_actions_df=corporate_actions_df,
        )
        return result
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        _user_log(f"Tax Report Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
