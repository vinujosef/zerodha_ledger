import pandas as pd
import io
import re
from datetime import date

def _user_log(message: str):
    print(f"🧾 {message}")

def _normalize_cell(val):
    if pd.isna(val):
        return ""
    return str(val).strip()

def _parse_float(val):
    try:
        v = str(val).replace(',', '').replace('(', '-').replace(')', '').strip()
        v = re.sub(r'(cr|dr)$', '', v, flags=re.IGNORECASE).strip()
        f_val = float(v)
        if pd.isna(f_val):
            return None
        return f_val
    except Exception:
        return None

def _find_date(df: pd.DataFrame):
    for i in range(min(30, len(df))):
        row_str = df.iloc[i].astype(str).str.cat(sep=' ')
        if "Trade Date" in row_str:
            for col_idx in range(len(df.columns)):
                cell_val = str(df.iloc[i, col_idx])
                match = re.search(r'\d{2}[-/]\d{2}[-/]\d{4}', cell_val)
                if match:
                    try:
                        return pd.to_datetime(match.group(0), dayfirst=True).date()
                    except Exception:
                        continue
    # Fallback: first date-like value in first 10 rows
    for i in range(min(10, len(df))):
        for col_idx in range(len(df.columns)):
            cell_val = str(df.iloc[i, col_idx])
            match = re.search(r'\d{2}[-/]\d{2}[-/]\d{4}', cell_val)
            if match:
                try:
                    return pd.to_datetime(match.group(0), dayfirst=True).date()
                except Exception:
                    continue
    return None

def _find_contract_note_no(df: pd.DataFrame):
    # Prefer explicit Contract Note IDs like "CNT-25/26-176480604"
    id_pattern = re.compile(r'\b[A-Z]{2,5}[-/]\d{2}/\d{2}[-/]\d+\b')
    for i in range(min(30, len(df))):
        row = df.iloc[i].tolist()
        row_str = " ".join([str(x) for x in row])
        if "Contract Note" in row_str or "Contract note" in row_str:
            for j in range(len(row)):
                cell = str(row[j])
                if re.search(r'Contract\s*Note', cell, re.IGNORECASE):
                    # First try: adjacent cells to the right for a proper ID pattern.
                    for k in range(j + 1, len(row)):
                        val = str(row[k]).strip()
                        if not val or val.lower() == "nan":
                            continue
                        m = id_pattern.search(val)
                        if m:
                            return m.group(0)
                    # Second try: any cell in the same row with a proper ID pattern.
                    for k in range(len(row)):
                        val = str(row[k]).strip()
                        if not val or val.lower() == "nan":
                            continue
                        m = id_pattern.search(val)
                        if m:
                            return m.group(0)
                    # Try extracting number from the same cell first.
                    inline_match = re.search(
                        r'contract\s*note(?:\s*(?:no\.?|number))?\s*[:\-]?\s*([A-Za-z0-9/-]+)',
                        cell,
                        re.IGNORECASE
                    )
                    if inline_match:
                        val = inline_match.group(1).strip()
                        if val and not re.match(r'\d{2}[-/]\d{2}[-/]\d{4}', val):
                            return val
                    # Next non-empty cell is likely the number
                    for k in range(j + 1, len(row)):
                        val = str(row[k]).strip()
                        if val and val.lower() != "nan":
                            if re.match(r'\d{2}[-/]\d{2}[-/]\d{4}', val):
                                continue
                            return val
    # Fallback: scan first 30 rows for a contract note ID pattern anywhere.
    for i in range(min(30, len(df))):
        row = df.iloc[i].tolist()
        for cell in row:
            val = str(cell).strip()
            if not val or val.lower() == "nan":
                continue
            m = id_pattern.search(val)
            if m:
                return m.group(0)
    return None

def _normalize_header(text):
    return re.sub(r'\s+', ' ', str(text).strip().lower())

_TRADE_HEADER_ALIASES = {
    "order_no": {"order no", "order number"},
    "order_time": {"order time"},
    "trade_no": {"trade no", "trade number"},
    "trade_time": {"trade time"},
    "security_desc": {
        "security / contract description",
        "security/contract description",
        "security description",
        "security / contract",
    },
    "side": {"buy/sell", "buy / sell", "b/s", "buy(b)/ sell(s)", "buy (b) / sell (s)"},
    "quantity": {"quantity", "qty"},
    "exchange": {"exchange"},
    "gross_rate": {"gross rate", "rate", "trade price per unit", "gross rate/trade price per unit(rs.)"},
    "net_total": {"net total", "net rate per unit(rs.)", "net rate per unit", "net rate"},
}

_REQUIRED_TRADE_FIELDS = {"security_desc", "quantity"}

def _detect_trade_header_fixed(df: pd.DataFrame):
    for i in range(len(df)):
        row = df.iloc[i].tolist()
        col_map = {}
        for j, cell in enumerate(row):
            norm = _normalize_header(cell)
            for key, labels in _TRADE_HEADER_ALIASES.items():
                if key in col_map:
                    continue
                if any(label in norm for label in labels):
                    col_map[key] = j
                    break
        if _REQUIRED_TRADE_FIELDS.issubset(col_map.keys()):
            return i, col_map
    return None, None

_CHARGE_LABELS = {
    "pay_in_out_obligation": {
        "pay in/pay out obligation (₹)",
        "pay in / pay out obligation",
        "pay in/pay out obligation",
    },
    "taxable_value_of_supply": {
        "taxable value of supply (brokerage) (₹)",
        "taxable value of supply (brokerage)",
        "brokerage",
        "brokerage charges",
    },
    "exchange_txn_charges": {"exchange transaction charges (₹)", "exchange transaction charges"},
    "clearing_charges": {"clearing charges (₹)", "clearing charges"},
    "cgst": {
        "cgst (@9% of brok, sebi, trans & clearing charges) (₹)",
        "central gst (@9% of brokerage and transaction charges)",
        "central gst",
        "cgst",
    },
    "sgst": {
        "sgst (@9% of brok, sebi, trans & clearing charges) (₹)",
        "state gst (@9% of brokerage and transaction charges)",
        "state gst",
        "sgst",
    },
    "igst": {
        "igst (@18% of brok, sebi, trans & clearing charges) (₹)",
        "integrated gst (@18% of brokerage and transaction charges)",
        "integrated gst",
        "igst",
    },
    "stt": {"securities transaction tax (₹)", "securities transaction tax", "stt"},
    "sebi_txn_tax": {"sebi turnover fees (₹)", "sebi turnover fees"},
    "stamp_duty": {"stamp duty (₹)", "stamp duty"},
    "net_amount_receivable": {
        "net amount receivable/(payable by client)",
        "net amount receivable by client / (payable by client)",
        "net amount receivable / (payable by client)",
        "net amount receivable",
    },
}

def _extract_row_value(row):
    for val in reversed(row):
        f = _parse_float(val)
        if f is not None:
            return f
    return None

def _extract_charges_fixed(df: pd.DataFrame):
    charges = {
        "pay_in_out_obligation": None,
        "taxable_value_of_supply": None,
        "exchange_txn_charges": None,
        "clearing_charges": None,
        "cgst": None,
        "sgst": None,
        "igst": None,
        "stt": None,
        "sebi_txn_tax": None,
        "stamp_duty": None,
        "net_amount_receivable": None,
    }
    debug = {"matched_rows": [], "missing_fields": []}
    for i in range(len(df)):
        row = df.iloc[i].tolist()
        row_labels = [_normalize_header(cell) for cell in row if _normalize_header(cell)]
        for key, labels in _CHARGE_LABELS.items():
            if charges[key] is not None:
                continue
            if any(any(label in row_label for label in labels) for row_label in row_labels):
                val = _extract_row_value(row)
                if val is not None:
                    charges[key] = val
                    debug["matched_rows"].append({
                        "field": key,
                        "row_index": i,
                        "value": val
                    })
    debug["missing_fields"] = [k for k, v in charges.items() if v is None]
    return charges, debug

_OPTIONAL_ZERO_CHARGE_FIELDS = {
    "taxable_value_of_supply",
    "cgst",
    "sgst",
    "igst",
}

def _parse_contract_note_df(df: pd.DataFrame, sheet_name: str):
    if df is None or df.empty:
        return None

    trade_date = _find_date(df)
    if not trade_date:
        _user_log(f"[parse_contract_note] Skipping sheet '{sheet_name}': could not detect trade date.")
        return None

    contract_note_no = _find_contract_note_no(df)
    header_idx, col_map = _detect_trade_header_fixed(df)
    trades = []
    warnings = []

    if header_idx is not None:
        for i in range(header_idx + 1, len(df)):
            row = df.iloc[i].tolist()

            def get_col(key):
                if key not in col_map:
                    return None
                return row[col_map[key]]

            security_desc = _normalize_cell(get_col("security_desc"))
            qty_val = _parse_float(get_col("quantity"))
            if not security_desc and qty_val is None:
                continue
            if qty_val is None or qty_val == 0:
                continue

            raw_side = _normalize_cell(get_col("side")).upper() if get_col("side") is not None else ""
            if raw_side in ["B", "BUY"]:
                side = "BUY"
            elif raw_side in ["S", "SELL"]:
                side = "SELL"
            else:
                side = None

            trade = {
                "contract_note_no": contract_note_no,
                "trade_date": trade_date,
                "order_no": _normalize_cell(get_col("order_no")),
                "order_time": _normalize_cell(get_col("order_time")),
                "trade_no": _normalize_cell(get_col("trade_no")),
                "trade_time": _normalize_cell(get_col("trade_time")),
                "security_desc": security_desc,
                "side": side,
                "quantity": qty_val,
                "exchange": _normalize_cell(get_col("exchange")),
                "gross_rate": _parse_float(get_col("gross_rate")),
                "net_total": _parse_float(get_col("net_total")),
                "sheet_name": sheet_name
            }
            trades.append(trade)
    else:
        warnings.append("Required trade table headers not found; sheet skipped.")
        _user_log(f"[parse_contract_note] Skipping sheet '{sheet_name}': required trade headers missing.")
        return None

    charges, charges_debug = _extract_charges_fixed(df)
    for key in _OPTIONAL_ZERO_CHARGE_FIELDS:
        if charges.get(key) is None:
            charges[key] = 0.0

    actionable_missing = [k for k, v in charges.items() if v is None]
    charges_debug["missing_fields"] = actionable_missing
    if actionable_missing:
        warnings.append(f"Missing charge fields: {', '.join(actionable_missing)}")

    return {
        "trade_date": trade_date,
        "contract_note_no": contract_note_no,
        "sheet_name": sheet_name,
        "trades": trades,
        "charges": charges,
        "charges_debug": charges_debug,
        "warnings": warnings,
    }

def parse_contract_note(content: bytes):
    """
    Parses Zerodha Contract Note (supports .xlsx and .csv).
    Returns a list of parsed sheets with trades + charges.
    """
    try:
        parsed_rows = []

        # STRATEGY 1: Try reading as Excel (.xlsx) first (all sheets)
        try:
            sheets = pd.read_excel(io.BytesIO(content), sheet_name=None, header=None, engine='openpyxl')
            for sheet_name, df in sheets.items():
                parsed = _parse_contract_note_df(df, sheet_name)
                if parsed:
                    parsed_rows.append(parsed)
        except:
            # STRATEGY 2: Fallback to CSV
            df = pd.read_csv(io.BytesIO(content), header=None)
            parsed = _parse_contract_note_df(df, "Sheet1")
            if parsed:
                parsed_rows.append(parsed)

        if not parsed_rows:
            _user_log("[parse_contract_note] No sheets matched the expected fixed schema.")
            return []

        return parsed_rows
    except Exception as e:
        _user_log(f"Global Parsing Error: {e}")
        return []

def parse_tradebook(content: bytes):
    """
    Parse Zerodha Tradebook CSV into a normalized dataframe.
    """
    try:
        df = pd.read_csv(io.BytesIO(content))
    except Exception:
        raise ValueError("Could not read Tradebook. Ensure it is a valid CSV file.")

    required_cols = ['trade_id', 'symbol', 'trade_date', 'trade_type', 'quantity', 'price']
    missing = [c for c in required_cols if c not in df.columns]
    if missing:
        raise ValueError(f"Tradebook CSV missing columns: {missing}")

    try:
        df['trade_date'] = pd.to_datetime(df['trade_date']).dt.date
    except Exception:
        raise ValueError("Date format error in Tradebook. Expected YYYY-MM-DD.")

    df['trade_id'] = df['trade_id'].astype(str)
    df['symbol'] = df['symbol'].astype(str)
    df['isin'] = df.get('isin', '').astype(str) if 'isin' in df.columns else ''
    df['trade_type'] = df['trade_type'].astype(str).str.upper()
    df['quantity'] = df['quantity'].astype(float)
    df['price'] = df['price'].astype(float)
    df['gross_amount'] = df['quantity'] * df['price']

    return df

def _apply_allocations(trades_df, notes_df):
    if trades_df.empty:
        return trades_df.copy()

    merged = trades_df.merge(notes_df, on='date', how='left')
    # Allocate only actual charges, not settlement/net receivable.
    merged['total_brokerage'] = merged.get('total_brokerage', 0.0)
    merged['total_taxes'] = merged.get('total_taxes', 0.0)
    merged['total_other_charges'] = merged.get('total_other_charges', 0.0)
    merged['daily_charges'] = (
        merged['total_brokerage'].fillna(0.0).abs() +
        merged['total_taxes'].fillna(0.0).abs() +
        merged['total_other_charges'].fillna(0.0).abs()
    )

    daily_turnover = merged.groupby('date')['gross_amount'].transform('sum')

    merged['allocated'] = 0.0
    mask = daily_turnover > 0
    merged.loc[mask, 'allocated'] = (
        merged.loc[mask, 'gross_amount'] / daily_turnover.loc[mask]
    ) * merged.loc[mask, 'daily_charges']

    merged['net_price'] = merged.apply(
        lambda x: (x['gross_amount'] + x['allocated']) / x['quantity']
        if x['type'] == 'BUY'
        else (x['gross_amount'] - x['allocated']) / x['quantity'],
        axis=1
    )
    return merged

def calculate_fifo_holdings(trades_df, notes_df, up_to_date=None):
    """
    FIFO holdings from trades up to a given date (inclusive).
    Returns {symbol: [{'qty': float, 'price': float}, ...]}
    """
    if trades_df.empty:
        return {}

    df = trades_df.copy()
    if up_to_date:
        df = df[df['date'] <= up_to_date]

    merged = _apply_allocations(df, notes_df)

    holdings = {}
    for _, row in merged.sort_values('date').iterrows():
        sym = row['symbol']
        if sym not in holdings:
            holdings[sym] = []

        if row['type'] == 'BUY':
            holdings[sym].append({'qty': row['quantity'], 'price': row['net_price']})
        elif row['type'] == 'SELL':
            qty_to_sell = row['quantity']
            while qty_to_sell > 0.0001 and holdings[sym]:
                batch = holdings[sym][0]
                if batch['qty'] > qty_to_sell:
                    batch['qty'] -= qty_to_sell
                    qty_to_sell = 0
                else:
                    qty_to_sell -= batch['qty']
                    holdings[sym].pop(0)

    return holdings

def calculate_realized_gains(trades_df, notes_df):
    """
    Returns list of realized gain records for each SELL trade using FIFO.
    Includes avg buy price for the matched lots.
    """
    if trades_df.empty:
        return []

    merged = _apply_allocations(trades_df, notes_df)
    merged = merged.sort_values('date')

    lots = {}
    realized = []

    for _, row in merged.iterrows():
        sym = row['symbol']
        if sym not in lots:
            lots[sym] = []

        if row['type'] == 'BUY':
            lots[sym].append({'qty': row['quantity'], 'price': row['net_price']})
        elif row['type'] == 'SELL':
            qty_to_sell = row['quantity']
            sell_price = row['net_price']
            realized_pnl = 0.0
            total_buy_cost = 0.0
            total_buy_qty = 0.0

            while qty_to_sell > 0.0001 and lots[sym]:
                batch = lots[sym][0]
                take_qty = min(batch['qty'], qty_to_sell)
                realized_pnl += (sell_price - batch['price']) * take_qty
                total_buy_cost += batch['price'] * take_qty
                total_buy_qty += take_qty
                batch['qty'] -= take_qty
                qty_to_sell -= take_qty
                if batch['qty'] <= 0.0001:
                    lots[sym].pop(0)

            realized.append({
                'symbol': sym,
                'sell_date': row['date'],
                'sell_qty': row['quantity'],
                'sell_price': sell_price,
                'avg_buy_price': (total_buy_cost / total_buy_qty) if total_buy_qty > 0 else 0.0,
                'realized_pnl': realized_pnl
            })

    return realized

def detect_unmatched_sells(trades_df):
    """
    Detect SELL rows where FIFO lots are insufficient (missing prior BUY history).
    Returns rows with unmatched quantity.
    """
    if trades_df.empty:
        return []

    df = trades_df.sort_values('date')
    lots = {}
    unmatched = []

    for _, row in df.iterrows():
        sym = row['symbol']
        if sym not in lots:
            lots[sym] = []

        if row['type'] == 'BUY':
            lots[sym].append({'qty': float(row['quantity'])})
            continue

        if row['type'] != 'SELL':
            continue

        qty_to_sell = float(row['quantity'])
        while qty_to_sell > 0.0001 and lots[sym]:
            batch = lots[sym][0]
            take_qty = min(batch['qty'], qty_to_sell)
            batch['qty'] -= take_qty
            qty_to_sell -= take_qty
            if batch['qty'] <= 0.0001:
                lots[sym].pop(0)

        if qty_to_sell > 0.0001:
            unmatched.append({
                "symbol": sym,
                "sell_date": row['date'],
                "sell_qty": float(row['quantity']),
                "unmatched_qty": round(float(qty_to_sell), 4),
            })

    return unmatched

def fy_label(d: date):
    year = d.year + 1 if d.month >= 4 else d.year
    return f"FY{year}"
