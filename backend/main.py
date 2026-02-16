from fastapi import FastAPI, UploadFile, File, Depends, HTTPException
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
)
from core import (
    parse_contract_note,
    parse_tradebook,
    calculate_fifo_holdings,
    calculate_realized_gains,
    detect_unmatched_sells,
    fy_label,
)

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
    print(f"🧾 {message}")

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

# --- ENDPOINTS ---

@app.post("/ingest/preview")
async def ingest_preview(
    tradebook: UploadFile = File(...),
    contracts: Optional[List[UploadFile]] = File(None),
    db: Session = Depends(get_db)
):
    try:
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
            try:
                content = await cf.read()
                parsed_list = parse_contract_note(content)
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

        # 2) Parse tradebook (required)
        tb_content = await tradebook.read()
        try:
            trades_df = parse_tradebook(tb_content)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

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
            "contract_notes_count": len(contract_rows),
            "contract_trade_rows_count": len(contract_trade_rows),
            "contract_charge_rows_count": len(contract_charge_rows),
            "parsed_sheets_count": len(contract_charge_rows),
            "missing_contract_note_dates": missing_dates,
            "warnings": errors,
        }

        batch_id = str(uuid.uuid4())
        batch = UploadBatch(
            id=batch_id,
            created_at=datetime.utcnow(),
            is_committed=False,
            tradebook_filename=tradebook.filename,
            contract_filenames=[c.filename for c in (contracts or [])],
            trade_rows=trade_rows,
            contract_rows=contract_rows,
            contract_trade_rows=contract_trade_rows,
            contract_charge_rows=contract_charge_rows,
            summary=summary,
        )
        db.add(batch)
        db.commit()

        return {
            "staging_id": batch_id,
            "summary": summary,
            "trade_rows_preview": trade_rows[:50],
            "contract_rows_preview": contract_rows[:50],
            "contract_trade_rows_preview": contract_trade_rows[:50],
            "contract_charge_rows_preview": contract_charge_rows[:50],
        }
    except HTTPException as he:
        raise he
    except Exception as e:
        _user_log(f"Preview Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

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

def _resolve_latest_prices(symbols: list[str], alias_map: dict[str, str]):
    if not symbols:
        return {}, []
    mapped = {s: alias_map.get(s, s) for s in symbols}
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
        holdings_dict = calculate_fifo_holdings(trades_df, notes_df)

        # 4. Live Data
        active_symbols = [s for s, batches in holdings_dict.items() if sum(b['qty'] for b in batches) > 0.01]
        live_prices = {}
        missing_symbols = []
        alias_map = _load_symbol_alias_map(db)
        
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
        realized = calculate_realized_gains(trades_df, notes_df)
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

        holdings_fy = calculate_fifo_holdings(trades_df, notes_df, up_to_date=fy_end)
        holdings_prev = calculate_fifo_holdings(trades_df, notes_df, up_to_date=prev_fy_end)

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

        if trades_df.empty:
            return {"networth_by_fy": [], "charges_by_fy": []}

        fy_set = sorted({fy_label(d) for d in trades_df['date']})

        # Live prices for current holdings symbols
        holdings_dict = calculate_fifo_holdings(trades_df, notes_df)
        active_symbols = [s for s, batches in holdings_dict.items() if sum(b['qty'] for b in batches) > 0.01]
        live_prices = {}
        if active_symbols:
            try:
                alias_map = _load_symbol_alias_map(db)
                live_prices, _ = _resolve_latest_prices(active_symbols, alias_map)
            except Exception as e:
                _user_log(f"YFinance Error: {e}")

        networth_by_fy = []
        for fy in fy_set:
            fy_end = _fy_end_date(fy)
            holdings_fy = calculate_fifo_holdings(trades_df, notes_df, up_to_date=fy_end)
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
def get_report_realized(fy: str, db: Session = Depends(get_db)):
    try:
        trades_df = pd.read_sql(db.query(Trade).statement, db.bind)
        notes_df = pd.read_sql(db.query(ContractNote).statement, db.bind)
        if trades_df.empty:
            return {"fy": fy, "rows": []}

        realized = calculate_realized_gains(trades_df, notes_df)
        rows = []
        for r in realized:
            if fy_label(r["sell_date"]) == fy:
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
