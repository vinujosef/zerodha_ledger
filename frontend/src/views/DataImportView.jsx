import React from 'react';
import { toNumber, formatIN } from '../utils/formatters';

function DataImportView({
  loading,
  handlePreview,
  handleCommit,
  preview,
  tradeFiles,
  contractFiles,
  setTradeFiles,
  setContractFiles,
}) {
  const [showSummaryModal, setShowSummaryModal] = React.useState(false);
  const [needsReviewOnly, setNeedsReviewOnly] = React.useState(false);
  const [selectedLinkId, setSelectedLinkId] = React.useState(null);
  const tradebookInputRef = React.useRef(null);
  const contractInputRef = React.useRef(null);
  const fmt = (val) => formatIN(val, { min: 2, max: 2 });
  const fmtCharge = (val) => {
    const n = toNumber(val);
    if (n === null || n === 0) return '—';
    return formatIN(n, { min: 2, max: 2 });
  };

  const contractChargeRows = preview?.contract_charge_rows_preview || [];
  const splitImpactRows = preview?.split_impact_rows_preview || [];
  const selectedTradeFiles = tradeFiles ? Array.from(tradeFiles) : [];
  const selectedContractFiles = contractFiles ? Array.from(contractFiles) : [];

  const normalizeNoteKey = (val) => {
    if (!val) return '';
    return String(val).replace(/\.(xlsx|xls|csv)$/i, '');
  };

  const noteKeyForTrade = (t) => normalizeNoteKey(t?.contract_note_no || t?.file_name || t?.sheet_name || '—');

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

  const splitBySymbol = React.useMemo(() => {
    const map = new Map();
    for (const row of splitImpactRows) {
      const symbol = String(row.symbol || '').toUpperCase();
      if (!symbol) continue;
      if (!map.has(symbol)) map.set(symbol, []);
      map.get(symbol).push(row);
    }
    for (const [symbol, rows] of map.entries()) {
      rows.sort((a, b) => String(a.split_date).localeCompare(String(b.split_date)));
      map.set(symbol, rows);
    }
    return map;
  }, [splitImpactRows]);

  const noteCountByNoteDate = React.useMemo(() => {
    const map = new Map();
    for (const t of (preview?.contract_trade_rows_preview || [])) {
      const note = noteKeyForTrade(t) || '—';
      const key = `${note}::${t.trade_date || '—'}`;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }, [preview]);

  const dailyContractByDate = React.useMemo(() => {
    const map = new Map();
    for (const row of (preview?.contract_rows_preview || [])) {
      map.set(row.date, row);
    }
    return map;
  }, [preview]);

  const chargesByDate = React.useMemo(() => {
    const map = new Map();
    for (const row of contractChargeRows) {
      if (!map.has(row.trade_date)) map.set(row.trade_date, row);
    }
    return map;
  }, [contractChargeRows]);

  const correlationRows = React.useMemo(() => {
    return (preview?.trade_rows_preview || []).map((trade, index) => {
      const match = findContractMatch(trade);
      const cnPrice = calcContractPrice(match);
      const tbQty = toNumber(trade.quantity);
      const cnQty = toNumber(match?.quantity);
      const qtyDiff = tbQty !== null && cnQty !== null ? tbQty - cnQty : null;
      const priceDiff = toNumber(trade.price) !== null && cnPrice !== null ? toNumber(trade.price) - cnPrice : null;
      const qtyMismatch = qtyDiff !== null && Math.abs(qtyDiff) >= 0.001;
      const priceMismatch = isMismatch(trade, cnPrice);
      const symbol = String(trade.symbol || '').toUpperCase();
      const splitEvents = (splitBySymbol.get(symbol) || []).filter((s) => String(s.split_date) >= String(trade.date));
      let status = 'OK';
      let reason = 'Tradebook and Contract Note are aligned.';
      if (!match) {
        status = 'No CN';
        reason = 'No contract-note row matched this tradebook entry.';
      } else if (qtyMismatch || priceMismatch) {
        status = 'Review';
        if (qtyMismatch && priceMismatch) reason = 'Both quantity and price differ from Contract Note.';
        else if (qtyMismatch) reason = 'Quantity differs from Contract Note.';
        else reason = 'Price differs from Contract Note.';
      }
      return {
        linkId: `L-${index + 1}`,
        trade,
        match,
        cnPrice,
        qtyDiff,
        priceDiff,
        status,
        reason,
        splitEvents,
        charge: chargesByDate.get(trade.date) || null,
        exchange: (match?.exchange || '').toUpperCase() || '—',
      };
    });
  }, [preview, splitBySymbol, chargesByDate]);

  const displayedRows = React.useMemo(() => {
    if (!needsReviewOnly) return correlationRows;
    return correlationRows.filter((r) => r.status !== 'OK');
  }, [needsReviewOnly, correlationRows]);

  const issuesCount = React.useMemo(() => correlationRows.filter((r) => r.status !== 'OK').length, [correlationRows]);

  const selectedRow = React.useMemo(
    () => displayedRows.find((r) => r.linkId === selectedLinkId) || displayedRows[0] || null,
    [displayedRows, selectedLinkId]
  );

  const selectedTradebookContractId = React.useMemo(() => {
    if (!selectedRow) return '—';
    const note = noteKeyForTrade(selectedRow.match) || '—';
    const key = `${note}::${selectedRow.trade.date}`;
    const count = noteCountByNoteDate.get(key) || 0;
    return count > 1 && note !== '—' ? `${note} (MULTI)` : note;
  }, [selectedRow, noteCountByNoteDate]);

  const selectedContractRows = React.useMemo(() => {
    if (!selectedRow) return [];
    const dayRows = (preview?.contract_trade_rows_preview || []).filter((r) => r.trade_date === selectedRow.trade.date);
    const byNote = new Map();
    for (const r of dayRows) {
      const note = noteKeyForTrade(r) || '—';
      const key = `${note}::${r.trade_date || '—'}`;
      const cnt = noteCountByNoteDate.get(key) || 0;
      const display = cnt > 1 && note !== '—' ? `${note} (MULTI)` : note;
      if (!byNote.has(display)) byNote.set(display, { contract_note: display });
    }
    const dayTotals = dailyContractByDate.get(selectedRow.trade.date) || null;
    const c = selectedRow.charge || {};
    const netAmount = toNumber(c.net_amount_receivable);
    const netText = netAmount === null
      ? '—'
      : `${fmtCharge(Math.abs(netAmount))} ${netAmount >= 0 ? '(Received)' : '(Spent)'}`;
    return Array.from(byNote.values()).map((x) => ({
      ...x,
      brokerage: c.brokerage ?? c.taxable_value_of_supply ?? dayTotals?.total_brokerage ?? null,
      exchange_txn_charges: c.exchange_txn_charges ?? null,
      clearing_charges: c.clearing_charges ?? null,
      cgst: c.cgst ?? null,
      sgst: c.sgst ?? null,
      igst: c.igst ?? null,
      stt: c.stt ?? null,
      sebi_turnover_fees: c.sebi_turnover_fees ?? c.sebi_txn_tax ?? null,
      stamp_duty: c.stamp_duty ?? null,
      net_total_text: netText,
    }));
  }, [selectedRow, preview, noteCountByNoteDate, dailyContractByDate]);

  const selectedTradeSplitRows = React.useMemo(() => {
    if (!selectedRow) return [];
    const baseQty = toNumber(selectedRow.trade.quantity);
    if (baseQty === null || baseQty <= 0) return [];
    const symbol = String(selectedRow.trade.symbol || '').toUpperCase();
    const splitEvents = (splitBySymbol.get(symbol) || []).filter((s) => String(s.split_date) >= String(selectedRow.trade.date));
    if (!splitEvents.length) return [];

    let runningQty = baseQty;
    return splitEvents
      .slice()
      .sort((a, b) => String(a.split_date).localeCompare(String(b.split_date)))
      .map((s) => {
        const rFrom = toNumber(s.ratio_from);
        const rTo = toNumber(s.ratio_to);
        if (rFrom === null || rTo === null || rFrom <= 0 || rTo <= 0) {
          return {
            split_date: s.split_date,
            ratio_from: s.ratio_from,
            ratio_to: s.ratio_to,
            affected_qty: null,
            became_qty: null,
          };
        }
        const factor = rTo / rFrom;
        const affectedQty = runningQty;
        const becameQty = affectedQty * factor;
        runningQty = becameQty;
        return {
          split_date: s.split_date,
          ratio_from: rFrom,
          ratio_to: rTo,
          affected_qty: affectedQty,
          became_qty: becameQty,
        };
      });
  }, [selectedRow, splitBySymbol]);

  React.useEffect(() => {
    if (!selectedRow) {
      setSelectedLinkId(null);
      return;
    }
    if (selectedLinkId !== selectedRow.linkId) {
      setSelectedLinkId(selectedRow.linkId);
    }
  }, [selectedRow, selectedLinkId]);

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
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <h4 className="text-sm font-semibold text-slate-900">Imported Trades</h4>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                    <span>Rows shown: <strong>{displayedRows.length}</strong></span>
                    <span>Issues: <strong>{issuesCount}</strong></span>
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={needsReviewOnly}
                        onChange={(e) => setNeedsReviewOnly(e.target.checked)}
                      />
                      Needs review only
                    </label>
                  </div>
                </div>
                <div className="mt-4 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs font-semibold text-slate-600 border-b">
                      <tr>
                        <th className="py-2 text-center">
                          <span className="group relative inline-flex items-center gap-1">
                            Status
                            <span
                              className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 text-[10px] text-slate-500"
                            >
                              i
                            </span>
                            <span className="pointer-events-none absolute left-1/2 top-full z-10 mt-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-medium text-slate-600 shadow group-hover:block">
                              OK = matched, Review = qty/price differs, No CN = no contract note match
                            </span>
                          </span>
                        </th>
                        <th className="py-2 text-center">Symbol</th>
                        <th className="py-2 text-center">Date</th>
                        <th className="py-2 text-center">NSE/BSE</th>
                        <th className="py-2 text-center">Type</th>
                        <th className="py-2 text-center">Qty</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {displayedRows.map((row) => {
                        const isSelected = selectedRow?.linkId === row.linkId;
                        const statusClass = row.status === 'OK'
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : row.status === 'No CN'
                            ? 'bg-rose-50 text-rose-700 border-rose-200'
                            : 'bg-amber-50 text-amber-700 border-amber-200';
                        return (
                          <tr
                            key={row.linkId}
                            className={`cursor-pointer text-slate-700 ${isSelected ? 'bg-slate-100' : 'hover:bg-slate-50'}`}
                            onClick={() => setSelectedLinkId(row.linkId)}
                          >
                            <td className="py-2 text-center">
                              <span className={`inline-block rounded-md border px-2 py-1 text-xs font-semibold ${statusClass}`}>
                                {row.status}
                              </span>
                            </td>
                            <td className="py-2 text-center font-semibold">{row.trade.symbol}</td>
                            <td className="py-2 text-center">{row.trade.date}</td>
                            <td className="py-2 text-center">{row.exchange}</td>
                            <td className="py-2 text-center">{row.trade.type}</td>
                            <td className="py-2 text-center">{fmt(row.trade.quantity)}</td>
                          </tr>
                        );
                      })}
                      {displayedRows.length === 0 && (
                        <tr>
                          <td className="py-3 text-sm text-slate-400" colSpan="6">No rows to display for current filter.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <h4 className="text-sm font-semibold text-slate-900">Detail Panel</h4>
                  <span className="text-xs text-slate-500">{selectedRow ? selectedRow.linkId : 'No selection'}</span>
                </div>
                {selectedRow ? (
                  <div className="space-y-4">
                    <div className="rounded-lg border border-sky-200 bg-sky-50 p-4">
                      <div className="text-xs font-semibold text-sky-800">Tradebook</div>
                      <div className="mt-2 overflow-auto">
                        <table className="w-full text-sm">
                          <thead className="text-xs font-semibold text-slate-600 border-b">
                            <tr>
                              <th className="py-2 text-center">Contract Note ID</th>
                              <th className="py-2 text-center">Trade ID</th>
                              <th className="py-2 text-center">Trade Date</th>
                              <th className="py-2 text-center">Exchange</th>
                              <th className="py-2 text-center">Segment</th>
                              <th className="py-2 text-center">Type</th>
                              <th className="py-2 text-center">Qty</th>
                              <th className="py-2 text-center">Price</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr className="text-slate-700">
                              <td className="py-2 text-center">{selectedTradebookContractId}</td>
                              <td className="py-2 text-center">{selectedRow.trade.trade_id}</td>
                              <td className="py-2 text-center">{selectedRow.trade.date}</td>
                              <td className="py-2 text-center">{selectedRow.exchange || '—'}</td>
                              <td className="py-2 text-center">—</td>
                              <td className="py-2 text-center">{selectedRow.trade.type}</td>
                              <td className="py-2 text-center">{fmt(selectedRow.trade.quantity)}</td>
                              <td className="py-2 text-center">{fmt(selectedRow.trade.price)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                      <div className="text-xs font-semibold text-amber-800">Contract Note</div>
                      <div className="mt-2 overflow-auto">
                        <table className="w-full text-sm">
                          <thead className="text-xs font-semibold text-slate-600 border-b">
                            <tr>
                              <th className="py-2 text-center">Contract Note ID</th>
                              <th className="py-2 text-center">Brokerage</th>
                              <th className="py-2 text-center">Exchange Txn Charges</th>
                              <th className="py-2 text-center">Clearing Charges</th>
                              <th className="py-2 text-center">CGST</th>
                              <th className="py-2 text-center">SGST</th>
                              <th className="py-2 text-center">IGST</th>
                              <th className="py-2 text-center">STT</th>
                              <th className="py-2 text-center">SEBI Turnover Fees</th>
                              <th className="py-2 text-center">Stamp Duty</th>
                              <th className="py-2 text-center">Net Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedContractRows.length > 0 ? (
                              selectedContractRows.map((r, idx) => (
                                <tr key={`${selectedRow.linkId}-cn-${idx}`} className="text-slate-700">
                                  <td className="py-2 text-center">{r.contract_note}</td>
                                  <td className="py-2 text-center">{fmtCharge(r.brokerage)}</td>
                                  <td className="py-2 text-center">{fmtCharge(r.exchange_txn_charges)}</td>
                                  <td className="py-2 text-center">{fmtCharge(r.clearing_charges)}</td>
                                  <td className="py-2 text-center">{fmtCharge(r.cgst)}</td>
                                  <td className="py-2 text-center">{fmtCharge(r.sgst)}</td>
                                  <td className="py-2 text-center">{fmtCharge(r.igst)}</td>
                                  <td className="py-2 text-center">{fmtCharge(r.stt)}</td>
                                  <td className="py-2 text-center">{fmtCharge(r.sebi_turnover_fees)}</td>
                                  <td className="py-2 text-center">{fmtCharge(r.stamp_duty)}</td>
                                  <td className="py-2 text-center">{r.net_total_text}</td>
                                </tr>
                              ))
                            ) : (
                              <tr>
                                <td className="py-3 text-sm text-rose-700 text-center" colSpan="11">No contract-note match found for this trade date.</td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                      <div className="text-xs font-semibold text-emerald-800">Split Check</div>
                      <div className="mt-2 overflow-auto">
                        <table className="w-full text-sm">
                          <thead className="text-xs font-semibold text-slate-600 border-b">
                            <tr>
                              <th className="py-2 text-center">Split Date</th>
                              <th className="py-2 text-center">Ratio</th>
                              <th className="py-2 text-center">Affected Quantity</th>
                              <th className="py-2 text-center">Became Quantity</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedTradeSplitRows.length > 0 ? (
                              selectedTradeSplitRows.map((s, idx) => (
                                <tr key={`${selectedRow.linkId}-split-${idx}`} className="text-slate-700">
                                  <td className="py-2 text-center">{s.split_date}</td>
                                  <td className="py-2 text-center">{`${s.ratio_from}:${s.ratio_to}`}</td>
                                  <td className="py-2 text-center">{s.affected_qty === null ? '—' : fmt(s.affected_qty)}</td>
                                  <td className="py-2 text-center">{s.became_qty === null ? '—' : fmt(s.became_qty)}</td>
                                </tr>
                              ))
                            ) : (
                              <tr>
                                <td className="py-3 text-sm text-slate-500 text-center" colSpan="4">No split event found after first buy date for this symbol.</td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <div className="text-xs text-slate-500">{selectedRow.reason}</div>
                  </div>
                ) : (
                  <div className="text-sm text-slate-500">No trade selected.</div>
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
                multiple
                onChange={(e) => setTradeFiles(e.target.files?.length ? e.target.files : null)}
                className="hidden"
              />
              <button
                onClick={() => tradebookInputRef.current?.click()}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-500"
              >
                Upload Tradebook(s)
              </button>
              <p className="mt-2 text-xs text-slate-600">
                You can select multiple years in one go.
              </p>
              <div className="mt-2 text-xs text-slate-700">
                {selectedTradeFiles.length > 0 ? `${selectedTradeFiles.length} file(s) selected` : 'No files selected'}
              </div>
              {selectedTradeFiles.length > 0 && (
                <div className="mt-2 max-h-24 overflow-auto rounded border border-emerald-200 bg-white/80 p-2 text-xs text-slate-700">
                  {selectedTradeFiles.map((f) => (
                    <div key={`${f.name}-${f.lastModified}`}>{f.name}</div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-xl border border-orange-200 bg-orange-50/60 p-4">
              <div className="text-xs uppercase tracking-widest text-slate-500 mb-2">Contract Notes (XLSX)</div>
              <input
                ref={contractInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                multiple
                onChange={(e) => setContractFiles(e.target.files?.length ? e.target.files : null)}
                className="hidden"
              />
              <button
                onClick={() => contractInputRef.current?.click()}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-orange-500 text-white hover:bg-orange-400"
              >
                Upload Contract Notes
              </button>
              <p className="mt-2 text-xs text-slate-600">
                Multiple files are supported.
              </p>
              <div className="mt-2 text-xs text-slate-700">
                {selectedContractFiles.length > 0 ? `${selectedContractFiles.length} file(s) selected` : 'No files selected'}
              </div>
              {selectedContractFiles.length > 0 && (
                <div className="mt-2 max-h-24 overflow-auto rounded border border-orange-200 bg-white/80 p-2 text-xs text-slate-700">
                  {selectedContractFiles.map((f) => (
                    <div key={`${f.name}-${f.lastModified}`}>{f.name}</div>
                  ))}
                </div>
              )}
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
