import React from 'react';
import { toNumber, formatIN } from '../utils/formatters';

function DataImportView({
  loading,
  handlePreview,
  handleCommit,
  preview,
  setTradeFile,
  setContractFiles,
}) {
  const [showSummaryModal, setShowSummaryModal] = React.useState(false);
  const tradebookInputRef = React.useRef(null);
  const contractInputRef = React.useRef(null);
  const fmt = (val) => formatIN(val, { min: 2, max: 2 });
  const fmtCharge = (val) => {
    const n = toNumber(val);
    if (n === null || n === 0) return '—';
    return formatIN(n, { min: 2, max: 2 });
  };

  const contractTradeRows = (preview?.contract_trade_rows_preview || [])
    .filter((r) => r.security_desc && toNumber(r.quantity) && toNumber(r.quantity) !== 0);

  const contractChargeRows = preview?.contract_charge_rows_preview || [];

  const normalizeNoteKey = (val) => {
    if (!val) return '';
    return String(val).replace(/\.(xlsx|xls|csv)$/i, '');
  };

  const noteKeyForTrade = (t) => normalizeNoteKey(t?.contract_note_no || t?.file_name || t?.sheet_name || '—');

  const makeNoteDisplay = (noteKey, count) => {
    if (!noteKey || noteKey === '—') return '—';
    if (count > 1) return `${noteKey} (MULTI)`;
    return noteKey;
  };

  const chargeBrokerage = (charge) => charge?.brokerage ?? charge?.taxable_value_of_supply;
  const chargeSebiFees = (charge) => charge?.sebi_turnover_fees ?? charge?.sebi_txn_tax;

  const extractSymbol = (desc) => {
    if (!desc) return '';
    const base = desc.split('-')[0];
    return base ? base.trim() : desc.trim();
  };

  const tradeCountByNoteDate = new Map();
  for (const t of contractTradeRows) {
    const noteKey = noteKeyForTrade(t);
    const key = `${noteKey}::${t.trade_date}`;
    tradeCountByNoteDate.set(key, (tradeCountByNoteDate.get(key) || 0) + 1);
  }

  const notePalette = [
    '#f8fafc', '#eff6ff', '#fef3c7', '#ecfdf3', '#ffe4e6', '#eef2ff', '#f0fdfa', '#fff7ed',
    '#fdf2f8', '#f1f5f9', '#e0f2fe', '#fef9c3', '#ecfccb', '#fae8ff', '#fee2e2', '#e0f2f1',
    '#ede9fe', '#f5f5f4', '#fef2f2', '#f8f8f8',
  ];
  const noteColorMap = new Map();
  let noteColorIndex = 0;
  const assignNoteColor = (key) => {
    if (!key || key === '—') return null;
    if (!noteColorMap.has(key)) {
      const color = notePalette[noteColorIndex] || `hsl(${(noteColorIndex * 137.508) % 360} 70% 96%)`;
      noteColorMap.set(key, color);
      noteColorIndex += 1;
    }
    return noteColorMap.get(key);
  };

  const findContractMatch = (trade) => {
    if (!preview?.contract_trade_rows_preview?.length) return null;
    const tSymbol = (trade.symbol || '').toUpperCase();
    const tDate = trade.date;
    const tQty = toNumber(trade.quantity);
    const matches = preview.contract_trade_rows_preview.filter((c) => {
      const cSymbol = (c.security_desc || '').toUpperCase();
      const cDate = c.trade_date;
      if (!cSymbol.includes(tSymbol)) return false;
      if (cDate !== tDate) return false;
      return true;
    });
    if (!matches.length) return null;
    if (tQty !== null) {
      const qtyMatch = matches.find((m) => Math.abs(toNumber(m.quantity) - tQty) < 0.001);
      if (qtyMatch) return qtyMatch;
    }
    return matches[0];
  };

  const noteKeys = new Set();
  for (const t of contractTradeRows) noteKeys.add(noteKeyForTrade(t));
  for (const t of preview?.trade_rows_preview || []) noteKeys.add(noteKeyForTrade(findContractMatch(t)));
  for (const key of noteKeys) assignNoteColor(key);

  const buildContractRows = () => {
    const tradebookByDateSymbol = new Map();
    for (const t of preview?.trade_rows_preview || []) {
      const key = `${t.date}::${(t.symbol || '').toUpperCase()}`;
      if (!tradebookByDateSymbol.has(key)) tradebookByDateSymbol.set(key, t);
    }

    const tradeByDate = new Map();
    for (const t of contractTradeRows) {
      if (!tradeByDate.has(t.trade_date)) tradeByDate.set(t.trade_date, t);
    }

    const chargeByDate = new Map();
    for (const c of contractChargeRows) {
      if (!chargeByDate.has(c.trade_date)) chargeByDate.set(c.trade_date, c);
    }

    const dates = Array.from(new Set([...tradeByDate.keys(), ...chargeByDate.keys()])).sort();
    return dates.map((d) => {
      const trade = tradeByDate.get(d);
      const charge = chargeByDate.get(d);
      const symbol = extractSymbol(trade?.security_desc || '');
      const tb = tradebookByDateSymbol.get(`${d}::${symbol.toUpperCase()}`);
      const noteKey = noteKeyForTrade(trade);
      const count = tradeCountByNoteDate.get(`${noteKey}::${d}`) || 0;
      return {
        date: d,
        trade,
        charge,
        fallbackSide: tb?.type || null,
        noteKey,
        noteDisplay: makeNoteDisplay(noteKey, count),
      };
    });
  };

  const calcContractPrice = (match) => {
    if (!match) return null;
    const grossRate = toNumber(match.gross_rate);
    if (grossRate !== null) return Math.abs(grossRate);
    const qty = toNumber(match.quantity);
    const net = toNumber(match.net_total);
    if (!qty || !net) return null;
    return Math.abs(net / qty);
  };

  const isMismatch = (trade, contractPrice) => {
    const tPrice = toNumber(trade.price);
    if (tPrice === null || contractPrice === null) return false;
    const diff = Math.abs(tPrice - contractPrice);
    const threshold = Math.max(0.1, tPrice * 0.001);
    return diff > threshold;
  };

  React.useEffect(() => {
    setShowSummaryModal(Boolean(preview));
  }, [preview]);

  return (
    <div className="mt-8 rounded-2xl bg-white border border-slate-200 shadow-sm p-6">
      {showSummaryModal && preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-[96vw] max-h-[92vh] rounded-2xl bg-white border border-slate-200 shadow-xl p-6 flex flex-col">
            <div className="flex items-center justify-between shrink-0">
              <h3 className="text-lg font-semibold text-slate-900">Import Summary</h3>
              <button
                type="button"
                onClick={() => setShowSummaryModal(false)}
                className="rounded-lg border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:bg-slate-50"
              >
                Close
              </button>
            </div>
            <div className="mt-4 overflow-y-auto pr-1 space-y-6">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm text-slate-700">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">Trades: <strong>{preview.summary.trades_count}</strong></div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">Contract Notes: <strong>{preview.summary.contract_notes_count}</strong></div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">CN Trades: <strong>{preview.summary.contract_trade_rows_count}</strong></div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">Charge Rows: <strong>{preview.summary.contract_charge_rows_count}</strong></div>
              </div>
              {preview.summary.missing_contract_note_dates.length > 0 && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                  Missing notes for {preview.summary.missing_contract_note_dates.length} trade dates.
                </div>
              )}
              {preview.summary.warnings?.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  {preview.summary.warnings.join('; ')}
                </div>
              )}

              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <h4 className="text-sm font-semibold text-slate-900">Tradebook Details</h4>
                </div>
                <div className="overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="text-[11px] md:text-xs font-semibold text-slate-600 border-b">
                      <tr>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">Contract Note</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">Symbol</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">Date</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">Buy/Sell</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">Qty</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">Trade Price</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">CN Price</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {preview.trade_rows_preview.map((t, i) => {
                        const match = findContractMatch(t);
                        const cnPrice = calcContractPrice(match);
                        const mismatch = isMismatch(t, cnPrice);
                        const matchNoteKey = noteKeyForTrade(match);
                        const noteBg = assignNoteColor(matchNoteKey);
                        const countForNote = tradeCountByNoteDate.get(`${matchNoteKey}::${t.date}`) || 0;
                        const noteDisplay = makeNoteDisplay(matchNoteKey, countForNote);
                        return (
                          <tr key={`${t.trade_id}-${i}`} className="text-slate-700" style={noteBg ? { backgroundColor: noteBg } : undefined}>
                            <td className="py-2 text-xs font-semibold text-center">{noteDisplay}</td>
                            <td className="py-2 font-medium text-center">{t.symbol}</td>
                            <td className="py-2 text-center">{t.date}</td>
                            <td className={`py-2 text-xs uppercase tracking-wide text-center ${t.type === 'BUY' ? 'text-sky-700' : 'text-amber-700'}`}>
                              {t.type === 'BUY' ? 'Buy' : 'Sell'}
                            </td>
                            <td className="py-2 text-center">{fmt(t.quantity)}</td>
                            <td className={`py-2 text-center ${mismatch ? 'text-rose-600 font-semibold' : ''}`}>{fmt(t.price)}</td>
                            <td className={`py-2 text-center ${mismatch ? 'text-rose-600 font-semibold' : 'text-slate-600'}`}>
                              {cnPrice === null ? '—' : cnPrice.toFixed(4)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="text-xs text-slate-400 mt-2">
                    Mismatch highlights only when the difference exceeds 0.1 or 0.1% of price (whichever is higher).
                  </p>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <h4 className="text-sm font-semibold text-slate-900">Contract Details</h4>
                </div>
                <div className="overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs font-semibold text-slate-600 border-b">
                      <tr>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">Contract Note</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">Date</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">Pay In / Pay Out Obligation</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">Brokerage</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">Exchange Transaction Charges</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">Clearing Charge</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">IGST</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">CGST</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">SGST</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">SEBI Turnover Fees</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">Stamp Duty</th>
                        <th className="py-2 text-center whitespace-normal break-words leading-tight">Net Amount Receivable/Payable</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {buildContractRows().map((row, i) => (
                        <tr key={`${row.date}-${i}`} className="text-slate-700" style={assignNoteColor(row.noteKey) ? { backgroundColor: assignNoteColor(row.noteKey) } : undefined}>
                          <td className="py-2 text-xs font-semibold text-center">{row.noteDisplay}</td>
                          <td className="py-2 text-center">{row.date}</td>
                          <td className="py-2 text-center">{fmtCharge(row.charge?.pay_in_out_obligation)}</td>
                          <td className="py-2 text-center">{fmtCharge(chargeBrokerage(row.charge))}</td>
                          <td className="py-2 text-center">{fmtCharge(row.charge?.exchange_txn_charges)}</td>
                          <td className="py-2 text-center">{fmtCharge(row.charge?.clearing_charges)}</td>
                          <td className="py-2 text-center">{fmtCharge(row.charge?.igst)}</td>
                          <td className="py-2 text-center">{fmtCharge(row.charge?.cgst)}</td>
                          <td className="py-2 text-center">{fmtCharge(row.charge?.sgst)}</td>
                          <td className="py-2 text-center">{fmtCharge(chargeSebiFees(row.charge))}</td>
                          <td className="py-2 text-center">{fmtCharge(row.charge?.stamp_duty)}</td>
                          <td className="py-2 text-center">{fmtCharge(row.charge?.net_amount_receivable)}</td>
                        </tr>
                      ))}
                      {buildContractRows().length === 0 && (
                        <tr>
                          <td className="py-3 text-sm text-slate-400" colSpan="13">No contract note rows detected.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {contractChargeRows.length > 0 && contractChargeRows.every((c) => !Object.values(c).some((v) => typeof v === 'number')) && (
                  <div className="mt-4 text-xs text-slate-500">
                    Charges are still empty. Debug info per sheet:
                    <pre className="mt-2 bg-slate-50 border border-slate-200 rounded p-2 overflow-auto">
                      {JSON.stringify(contractChargeRows.map((c) => c.debug), null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setShowSummaryModal(false)}
                className="px-4 py-2 rounded-lg text-sm font-semibold border border-slate-200 text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
              <button
                type="button"
                onClick={handleCommit}
                disabled={loading}
                className={`px-4 py-2 rounded-lg text-sm font-semibold ${loading ? 'bg-slate-200 text-slate-500' : 'bg-emerald-600 text-white hover:bg-emerald-500'}`}
              >
                {loading ? 'Committing...' : 'Confirm & Commit'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-5">
        <div className="rounded-2xl border border-sky-200 p-5 bg-gradient-to-br from-sky-50 via-cyan-50 to-white shadow-sm">
          <div className="text-lg font-semibold text-slate-900">Zerodha Console</div>
          <div className="mt-2 text-sm text-slate-600">
            Download files year by year from when you started using Zerodha (through Zerodha Console)
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
              <div className="text-sm font-semibold text-slate-900">Tradebook</div>
              <p className="mt-1 text-xs text-slate-600">
                Open the Tradebook page and download each year as CSV.
              </p>
              <button
                onClick={() => window.open('https://console.zerodha.com/reports/tradebook', '_blank', 'noopener,noreferrer')}
                className="mt-3 px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-500"
              >
                Open Tradebook
              </button>
            </div>
            <div className="rounded-xl border border-orange-200 bg-orange-50/60 p-4">
              <div className="text-sm font-semibold text-slate-900">Contract Notes</div>
              <p className="mt-1 text-xs text-slate-600">
                Open Downloads and get contract notes in XLSX format for each year.
              </p>
              <button
                onClick={() => window.open('https://console.zerodha.com/reports/downloads', '_blank', 'noopener,noreferrer')}
                className="mt-3 px-4 py-2 rounded-lg text-sm font-semibold bg-orange-500 text-white hover:bg-orange-400"
              >
                Open Contract Notes
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-indigo-200 p-5 bg-gradient-to-br from-indigo-50 via-violet-50 to-white shadow-sm">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Data Import (Preview & Confirm)</h3>
              <p className="text-sm text-slate-500">Upload downloaded files, preview data, then commit.</p>
            </div>
            <button
              onClick={handlePreview}
              disabled={loading}
              className={`px-4 py-2 rounded-lg text-sm font-semibold ${loading ? 'bg-slate-200 text-slate-500' : 'bg-slate-900 text-white hover:bg-slate-800'}`}
            >
              {loading ? 'Processing...' : 'Preview Upload'}
            </button>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
              <div className="text-xs uppercase tracking-widest text-slate-500 mb-2">Tradebook (CSV)</div>
              <input
                ref={tradebookInputRef}
                type="file"
                accept=".csv"
                onChange={(e) => setTradeFile(e.target.files[0])}
                className="hidden"
              />
              <button
                onClick={() => tradebookInputRef.current?.click()}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-500"
              >
                Upload Tradebook
              </button>
            </div>
            <div className="rounded-xl border border-orange-200 bg-orange-50/60 p-4">
              <div className="text-xs uppercase tracking-widest text-slate-500 mb-2">Contract Notes (XLSX)</div>
              <input
                ref={contractInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                multiple
                onChange={(e) => setContractFiles(e.target.files)}
                className="hidden"
              />
              <button
                onClick={() => contractInputRef.current?.click()}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-orange-500 text-white hover:bg-orange-400"
              >
                Upload Contract Notes
              </button>
            </div>
          </div>
        </div>
      </div>

      {preview && (
        <div className="mt-6">
          <div className="mb-4 flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-sm text-slate-600">Preview generated. Open the modal to review summary and details.</div>
            <button
              type="button"
              onClick={() => setShowSummaryModal(true)}
              className="px-3 py-2 rounded-lg text-xs font-semibold border border-slate-200 text-slate-700 hover:bg-slate-50"
            >
              Open Preview Modal
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default DataImportView;
