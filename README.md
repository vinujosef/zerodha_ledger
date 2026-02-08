# 📈 Zerodha Investment Ledger

Track Zerodha equity trades with FIFO accounting, contract note reconciliation, and a clean FY dashboard.

## Quick Start
1. Ensure Docker Desktop is running.
2. Run: `docker-compose up --build`
3. Open: `http://localhost:3000`

## Features
- **Preview → Commit ingestion:** Upload a Tradebook CSV plus multiple Contract Notes, review the preview, then commit.
- **Contract note parsing (xlsx/csv):** Extract trades + charges, keep per-sheet diagnostics for tricky layouts.
- **Mismatch detection:** Highlights when tradebook price diverges from contract note price beyond a threshold.
- **Charges breakdown:** CGST/SGST/IGST, STT, SEBI, exchange charges, stamp duty, net payable.
- **FY dashboards:** Net worth, YoY delta, realized P&L, and charts for net worth + charges by FY.
- **Holdings + realized tables:** Live holdings with P&L, plus realized trades per FY.
- **Symbol alias mapping:** Fix missing Yahoo Finance tickers (e.g., `HDFC` → `HDFCBANK`).

## Stack
- **Frontend:** React + Vite + Tailwind + Recharts
- **Backend:** FastAPI + SQLAlchemy
- **Database:** Postgres
- **Market data:** Yahoo Finance (via `yfinance`)

## Core Flow (UI)
### 1. Data Import
- Upload Tradebook CSV + all Contract Notes
- Preview summary counts + warnings
- Review tradebook rows alongside contract note prices
- Review contract note charge rows
- Confirm & commit

### 2. Dashboard
- FY selector
- Current net worth + YoY change
- Realized P&L for selected FY
- Net worth by FY (chart)
- Charges by FY (chart)
- Current holdings (live prices)
- Past holdings (realized trades)

### 3. Symbol Fixes
- If Yahoo tickers fail, map symbols to correct tickers and save aliases

## Key API Endpoints
- `POST /ingest/preview` — parse uploads and create a staging batch
- `POST /ingest/commit` — commit staging batch to the ledger
- `GET /dashboard?fy=FY2026` — holdings + summary for a FY
- `GET /reports/summary` — net worth + charges by FY
- `GET /reports/realized?fy=FY2026` — realized trades for a FY
- `POST /symbols/aliases` — upsert symbol aliases
- `GET /symbols/aliases` — list active aliases
