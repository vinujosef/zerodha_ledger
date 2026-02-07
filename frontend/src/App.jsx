import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid, Legend } from 'recharts';

const API_URL = "http://localhost:8000";

function App() {
  const [view, setView] = useState("dashboard");
  const [data, setData] = useState({
    holdings: [],
    health_issues: [],
    data_warnings: { unmatched_sells: [] },
    realized_pnl: 0,
    net_worth: 0,
    net_worth_yoy: 0,
    net_worth_note: "",
    fy_list: [],
    missing_symbols: [],
    symbol_aliases: {}
  });
  const [summary, setSummary] = useState({ networth_by_fy: [], charges_by_fy: [] });
  const [realized, setRealized] = useState([]);
  const [aliasEdits, setAliasEdits] = useState({});
  const [fy, setFy] = useState("");
  const [tradeFile, setTradeFile] = useState(null);
  const [contractFiles, setContractFiles] = useState(null);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [stagingId, setStagingId] = useState(null);

  const currentFY = () => {
    const now = new Date();
    const year = now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear();
    return `FY${year}`;
  };

  const fetchDashboard = async (fyValue) => {
    try {
      const res = await axios.get(`${API_URL}/dashboard`, { params: { fy: fyValue } });
      setData(res.data);
      if (res.data.fy_list?.length && !fy) {
        setFy(fyValue);
      }
    } catch (err) { console.error("Fetch Error:", err); }
  };

  const saveAliases = async (aliases) => {
    try {
      await axios.post(`${API_URL}/symbols/aliases`, { aliases });
      const fyValue = fy || currentFY();
      fetchDashboard(fyValue);
      fetchSummary();
      fetchRealized(fyValue);
      setAliasEdits({});
    } catch (err) {
      console.error("Alias save error:", err);
      alert("Failed to save symbol aliases.");
    }
  };

  const fetchSummary = async () => {
    try {
      const res = await axios.get(`${API_URL}/reports/summary`);
      setSummary(res.data);
    } catch (err) { console.error("Summary Error:", err); }
  };

  const fetchRealized = async (fyValue) => {
    try {
      const res = await axios.get(`${API_URL}/reports/realized`, { params: { fy: fyValue } });
      setRealized(res.data.rows || []);
    } catch (err) { console.error("Realized Error:", err); }
  };

  const handlePreview = async () => {
    if (!tradeFile || !contractFiles) return alert("Please select both Tradebook and Contract Notes first!");

    setLoading(true);
    const formData = new FormData();
    formData.append("tradebook", tradeFile);
    for (let i = 0; i < contractFiles.length; i++) {
      formData.append("contracts", contractFiles[i]);
    }

    try {
      const response = await axios.post(`${API_URL}/ingest/preview`, formData);
      setPreview(response.data);
      setStagingId(response.data.staging_id);
    } catch (error) {
      console.error("Upload Error:", error);

      if (error.response && error.response.data && error.response.data.detail) {
        alert(`❌ Upload Failed: ${error.response.data.detail}`);
      } else if (error.message) {
        alert(`❌ Network/Client Error: ${error.message}`);
      } else {
        alert("❌ Unknown Error Occurred.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!stagingId) return;
    setLoading(true);
    try {
      const response = await axios.post(`${API_URL}/ingest/commit`, { staging_id: stagingId });
      alert(response.data.message);
      setPreview(null);
      setStagingId(null);
      const fyValue = fy || currentFY();
      fetchDashboard(fyValue);
      fetchSummary();
      fetchRealized(fyValue);
      setView("dashboard");
    } catch (error) {
      console.error("Commit Error:", error);
      if (error.response && error.response.data && error.response.data.detail) {
        alert(`❌ Commit Failed: ${error.response.data.detail}`);
      } else if (error.message) {
        alert(`❌ Network/Client Error: ${error.message}`);
      } else {
        alert("❌ Unknown Error Occurred.");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const initialFY = currentFY();
    setFy(initialFY);
    fetchDashboard(initialFY);
    fetchSummary();
    fetchRealized(initialFY);
  }, []);

  const toNumber = (val) => {
    if (val === null || val === undefined || val === "") return null;
    const num = Number(val);
    return Number.isFinite(num) ? num : null;
  };

  const fmt = (val) => {
    const n = toNumber(val);
    if (n === null) return "—";
    return n.toLocaleString();
  };
  const fmtCharge = (val) => {
    const n = toNumber(val);
    if (n === null || n === 0) return "—";
    return n.toLocaleString();
  };

  const contractTradeRows = (preview?.contract_trade_rows_preview || [])
    .filter((r) => r.security_desc && toNumber(r.quantity) && toNumber(r.quantity) !== 0);

  const contractChargeRows = (preview?.contract_charge_rows_preview || []);
  const normalizeNoteKey = (val) => {
    if (!val) return "";
    return String(val).replace(/\.(xlsx|xls|csv)$/i, "");
  };
  const chargeBrokerage = (charge) => (charge?.brokerage ?? charge?.taxable_value_of_supply);
  const chargeSebiFees = (charge) => (charge?.sebi_turnover_fees ?? charge?.sebi_txn_tax);
  const extractSymbol = (desc) => {
    if (!desc) return "";
    const base = desc.split("-")[0];
    return base ? base.trim() : desc.trim();
  };
  const noteKeyForTrade = (t) => {
    return normalizeNoteKey(t?.contract_note_no || t?.file_name || t?.sheet_name || "—");
  };
  const makeNoteDisplay = (noteKey, count) => {
    if (!noteKey || noteKey === "—") return "—";
    if (count > 1) return `${noteKey} (MULTI)`;
    return noteKey;
  };
  const noteColorClass = (noteKey) => {
    if (!noteKey || noteKey === "—") return "";
    const palette = [
      "bg-slate-50",
      "bg-blue-50",
      "bg-amber-50",
      "bg-emerald-50",
      "bg-rose-50",
      "bg-indigo-50",
      "bg-teal-50",
      "bg-orange-50",
    ];
    let hash = 0;
    for (let i = 0; i < noteKey.length; i += 1) {
      hash = (hash * 31 + noteKey.charCodeAt(i)) % 100000;
    }
    return palette[hash % palette.length];
  };
  const tradeCountByNoteDate = new Map();
  for (const t of contractTradeRows) {
    const noteKey = noteKeyForTrade(t);
    const key = `${noteKey}::${t.trade_date}`;
    tradeCountByNoteDate.set(key, (tradeCountByNoteDate.get(key) || 0) + 1);
  }
  const notePalette = [
    "#f8fafc",
    "#eff6ff",
    "#fef3c7",
    "#ecfdf3",
    "#ffe4e6",
    "#eef2ff",
    "#f0fdfa",
    "#fff7ed",
    "#fdf2f8",
    "#f1f5f9",
    "#e0f2fe",
    "#fef9c3",
    "#ecfccb",
    "#fae8ff",
    "#fee2e2",
    "#e0f2f1",
    "#ede9fe",
    "#f5f5f4",
    "#fef2f2",
    "#f8f8f8"
  ];
  const noteColorMap = new Map();
  let noteColorIndex = 0;
  const assignNoteColor = (key) => {
    if (!key || key === "—") return null;
    if (!noteColorMap.has(key)) {
      const color = notePalette[noteColorIndex] || `hsl(${(noteColorIndex * 137.508) % 360} 70% 96%)`;
      noteColorMap.set(key, color);
      noteColorIndex += 1;
    }
    return noteColorMap.get(key);
  };
  const noteKeys = new Set();
  for (const t of contractTradeRows) {
    noteKeys.add(noteKeyForTrade(t));
  }
  const findContractMatch = (trade) => {
    if (!preview?.contract_trade_rows_preview?.length) return null;
    const tSymbol = (trade.symbol || "").toUpperCase();
    const tDate = trade.date;
    const tQty = toNumber(trade.quantity);
    const matches = preview.contract_trade_rows_preview.filter((c) => {
      const cSymbol = (c.security_desc || "").toUpperCase();
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

  for (const t of preview?.trade_rows_preview || []) {
    const match = findContractMatch(t);
    noteKeys.add(noteKeyForTrade(match));
  }
  for (const key of noteKeys) {
    assignNoteColor(key);
  }
  const buildContractRows = () => {
    const tradebookByDateSymbol = new Map();
    for (const t of preview?.trade_rows_preview || []) {
      const key = `${t.date}::${(t.symbol || "").toUpperCase()}`;
      if (!tradebookByDateSymbol.has(key)) {
        tradebookByDateSymbol.set(key, t);
      }
    }
    const tradeByDate = new Map();
    for (const t of contractTradeRows) {
      if (!tradeByDate.has(t.trade_date)) {
        tradeByDate.set(t.trade_date, t);
      }
    }
    const chargeByDate = new Map();
    for (const c of contractChargeRows) {
      if (!chargeByDate.has(c.trade_date)) {
        chargeByDate.set(c.trade_date, c);
      }
    }
    const dates = Array.from(new Set([...tradeByDate.keys(), ...chargeByDate.keys()])).sort();
    return dates.map((d) => {
      const trade = tradeByDate.get(d);
      const charge = chargeByDate.get(d);
      const symbol = extractSymbol(trade?.security_desc || "");
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

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-screen-2xl mx-auto px-4 py-10">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-widest text-slate-500">Zerodha Ledger</p>
            <h1 className="text-3xl font-semibold text-slate-900">My Investment Dashboard</h1>
            <p className="text-sm text-slate-500 mt-2">Preview, verify, and track portfolio growth</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setView("dashboard")}
              className={`px-4 py-2 rounded-lg text-sm font-semibold ${view === 'dashboard' ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
            >
              Dashboard
            </button>
            <button
              onClick={() => setView("import")}
              className={`px-4 py-2 rounded-lg text-sm font-semibold ${view === 'import' ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
            >
              Data Import
            </button>
          </div>
        </header>

        {view === "import" && (
          <div className="mt-8 rounded-2xl bg-white border border-slate-200 shadow-sm p-6">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Data Import (Preview → Confirm)</h3>
                <p className="text-sm text-slate-500">Upload your tradebook and contract notes, verify, then commit.</p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handlePreview}
                  disabled={loading}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold ${loading ? 'bg-slate-200 text-slate-500' : 'bg-slate-900 text-white hover:bg-slate-800'}`}
                >
                  {loading ? 'Processing...' : 'Preview Upload'}
                </button>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-slate-200 p-4 bg-slate-50">
                <label className="block text-xs uppercase tracking-widest text-slate-500 mb-2">Tradebook CSV</label>
                <input type="file" onChange={e => setTradeFile(e.target.files[0])} className="text-sm" />
              </div>
              <div className="rounded-xl border border-slate-200 p-4 bg-slate-50">
                <label className="block text-xs uppercase tracking-widest text-slate-500 mb-2">Contract Notes (Select All)</label>
                <input type="file" multiple onChange={e => setContractFiles(e.target.files)} className="text-sm" />
              </div>
            </div>

            {preview && (
              <div className="mt-6">
                <div className="text-sm text-slate-700">
                  <strong>Summary:</strong> {preview.summary.trades_count} trades, {preview.summary.contract_notes_count} contract notes, {preview.summary.contract_trade_rows_count} contract-note trades, {preview.summary.contract_charge_rows_count} charge rows.
                  {preview.summary.missing_contract_note_dates.length > 0 && (
                    <span className="text-rose-600">
                      {" "}Missing notes for {preview.summary.missing_contract_note_dates.length} trade dates.
                    </span>
                  )}
                </div>
                {preview.summary.warnings?.length > 0 && (
                  <div className="text-rose-600 text-xs mt-2">
                    {preview.summary.warnings.join('; ')}
                  </div>
                )}

                <div className="mt-5 space-y-6">
                  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="text-sm font-semibold text-slate-900">Tradebook Preview</h4>
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
                                <td className={`py-2 text-center ${mismatch ? 'text-rose-600 font-semibold' : ''}`}>
                                  {fmt(t.price)}
                                </td>
                                <td className={`py-2 text-center ${mismatch ? 'text-rose-600 font-semibold' : 'text-slate-600'}`}>
                                  {cnPrice === null ? "—" : cnPrice.toFixed(4)}
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
                      <h4 className="text-sm font-semibold text-slate-900">Contract Note Details</h4>
                    </div>

                    <div className="overflow-auto">
                      <table className="w-full text-sm">
                        <thead className="text-xs font-semibold text-slate-600 border-b">
                          <tr>
                            <th className="py-2 text-center whitespace-normal break-words leading-tight">Contract Note</th>
                            <th className="py-2 text-center whitespace-normal break-words leading-tight">Date</th>
                            <th className="py-2 text-center whitespace-normal break-words leading-tight">
                              <span className="block">Pay In /</span>
                              <span className="block">Pay Out</span>
                              <span className="block">Obligation</span>
                            </th>
                            <th className="py-2 text-center whitespace-normal break-words leading-tight">Brokerage</th>
                            <th className="py-2 text-center whitespace-normal break-words leading-tight">
                              <span className="block">Exchange</span>
                              <span className="block">Transaction</span>
                              <span className="block">Charges</span>
                            </th>
                            <th className="py-2 text-center whitespace-normal break-words leading-tight">
                              <span className="block">Clearing</span>
                              <span className="block">Charge</span>
                            </th>
                            <th className="py-2 text-center whitespace-normal break-words leading-tight">IGST</th>
                            <th className="py-2 text-center whitespace-normal break-words leading-tight">CGST</th>
                            <th className="py-2 text-center whitespace-normal break-words leading-tight">SGST</th>
                            <th className="py-2 text-center whitespace-normal break-words leading-tight">
                              <span className="block">SEBI</span>
                              <span className="block">Turnover</span>
                              <span className="block">Fees</span>
                            </th>
                            <th className="py-2 text-center whitespace-normal break-words leading-tight">
                              <span className="block">Stamp</span>
                              <span className="block">Duty</span>
                            </th>
                            <th className="py-2 text-center whitespace-normal break-words leading-tight">
                              <span className="block">Net Amount</span>
                              <span className="block">Receivable/</span>
                              <span className="block">Payable</span>
                            </th>
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
                    {contractChargeRows.length > 0 && contractChargeRows.every((c) => !Object.values(c).some((v) => typeof v === "number")) && (
                      <div className="mt-4 text-xs text-slate-500">
                        Charges are still empty. Debug info per sheet:
                        <pre className="mt-2 bg-slate-50 border border-slate-200 rounded p-2 overflow-auto">
                          {JSON.stringify(contractChargeRows.map(c => c.debug), null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>

                <button
                  onClick={handleCommit}
                  disabled={loading}
                  className={`mt-6 px-5 py-2 rounded-lg text-sm font-semibold ${loading ? 'bg-slate-200 text-slate-500' : 'bg-emerald-600 text-white hover:bg-emerald-500'}`}
                >
                  {loading ? 'Committing...' : 'Confirm & Commit'}
                </button>
              </div>
            )}
          </div>
        )}

        {view === "dashboard" && (
          <div className="mt-8 space-y-6">
          {data.data_warnings?.unmatched_sells?.length > 0 && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
              <div className="font-semibold">Potentially incorrect realized values detected</div>
              <div className="text-xs text-rose-700 mt-1">
                Some SELL trades do not have enough prior BUY history in the ledger. Until those BUY trades are imported,
                avg buy, sell price adjustments, and realized P&L may be inaccurate.
              </div>
              <div className="mt-3 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="text-rose-700 uppercase tracking-wide">
                    <tr>
                      <th className="text-left py-1">Symbol</th>
                      <th className="text-left py-1">Sell Date</th>
                      <th className="text-right py-1">Sell Qty</th>
                      <th className="text-right py-1">Unmatched Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.data_warnings.unmatched_sells.map((item, idx) => (
                      <tr key={`${item.symbol}-${item.sell_date}-${idx}`}>
                        <td className="py-1">{item.symbol}</td>
                        <td className="py-1">{item.sell_date}</td>
                        <td className="py-1 text-right">{item.sell_qty}</td>
                        <td className="py-1 text-right">{item.unmatched_qty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <div className="rounded-2xl bg-white shadow-sm border border-slate-200 p-6 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-widest text-slate-400">Current Net Worth</div>
              <div className={`text-3xl font-semibold ${data.net_worth_yoy >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                ₹{data.net_worth.toLocaleString()}
              </div>
                <div className={`text-sm mt-1 ${data.net_worth_yoy >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                  YoY: {data.net_worth_yoy >= 0 ? '+' : ''}₹{data.net_worth_yoy.toLocaleString()}
                </div>
                <div className="text-xs text-slate-400 mt-2">{data.net_worth_note}</div>
            </div>
            <div className="text-right">
                <div className="text-xs uppercase tracking-widest text-slate-400">Financial Year</div>
                <select
                  value={fy}
                  onChange={(e) => {
                    const nextFY = e.target.value;
                    setFy(nextFY);
                    fetchDashboard(nextFY);
                    fetchRealized(nextFY);
                  }}
                  className="mt-2 rounded-lg border border-slate-200 bg-white px-3 py-1 text-sm"
                >
                  {[...new Set([fy, ...(data.fy_list || [])])].filter(Boolean).map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
                <div className="text-sm mt-3">
                  <span className="text-slate-500">Realized P&L ({fy}): </span>
                  <span className={`font-semibold ${data.realized_pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {data.realized_pnl >= 0 ? '+' : ''}₹{data.realized_pnl.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-4 h-[320px]">
                <div className="text-sm font-semibold text-slate-900 mb-3">Net Worth by Financial Year</div>
                <ResponsiveContainer>
                  <BarChart data={summary.networth_by_fy}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="fy" />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="networth" fill="#0f172a">
                      {summary.networth_by_fy.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill="#0f172a" />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-4 h-[320px]">
                <div className="text-sm font-semibold text-slate-900 mb-3">Charges Paid by Financial Year</div>
                <ResponsiveContainer>
                  <BarChart data={summary.charges_by_fy}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="fy" />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="charges" fill="#ef4444" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-2xl bg-white border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b text-sm font-semibold text-slate-900">Current Holdings</div>
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-widest text-slate-400 border-b bg-slate-50">
                  <tr className="text-left">
                    <th className="px-4 py-3">Symbol</th>
                    <th className="px-4 py-3">Qty</th>
                    <th className="px-4 py-3">Avg Price</th>
                    <th className="px-4 py-3">LTP</th>
                    <th className="px-4 py-3">Invested</th>
                    <th className="px-4 py-3">Current</th>
                    <th className="px-4 py-3">P&L</th>
                    <th className="px-4 py-3">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.holdings.map(h => (
                    <tr key={h.symbol}>
                      <td className="px-4 py-3 font-semibold">{h.symbol}</td>
                      <td className="px-4 py-3">{h.quantity}</td>
                      <td className="px-4 py-3">{h.avg_price}</td>
                      <td className="px-4 py-3">{h.cmp}</td>
                      <td className="px-4 py-3">{h.invested_val.toLocaleString()}</td>
                      <td className="px-4 py-3">{h.current_val.toLocaleString()}</td>
                      <td className={`px-4 py-3 ${h.pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {h.pnl.toLocaleString()}
                      </td>
                      <td className={`px-4 py-3 ${h.pnl_pct >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {h.pnl_pct}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

          <div className="rounded-2xl bg-white border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b text-sm font-semibold text-slate-900">Past Holdings (Realized)</div>
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-widest text-slate-400 border-b bg-slate-50">
                  <tr className="text-left">
                    <th className="px-4 py-3">Symbol</th>
                    <th className="px-4 py-3">Sell Date</th>
                    <th className="px-4 py-3">Qty</th>
                    <th className="px-4 py-3">Avg Buy</th>
                    <th className="px-4 py-3">Sell Price</th>
                    <th className="px-4 py-3">Realized P&L</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {realized.map((r, idx) => (
                    <tr key={`${r.symbol}-${idx}`}>
                      <td className="px-4 py-3 font-semibold">{r.symbol}</td>
                      <td className="px-4 py-3">{r.sell_date}</td>
                      <td className="px-4 py-3">{r.sell_qty}</td>
                      <td className="px-4 py-3">{r.avg_buy_price}</td>
                      <td className="px-4 py-3">{r.sell_price}</td>
                      <td className={`px-4 py-3 ${r.realized_pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {r.realized_pnl}
                      </td>
                    </tr>
                  ))}
                  {realized.length === 0 && (
                    <tr>
                      <td className="px-4 py-4 text-sm text-slate-400" colSpan="6">No realized trades for this FY.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {data.missing_symbols?.length > 0 && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <div className="font-semibold">Price symbols not found</div>
              <div className="text-xs text-amber-800 mt-1">
                These symbols couldn’t be resolved on Yahoo Finance. Map them to their current ticker (without “.NS”).
              </div>
              <div className="mt-3 space-y-2">
                {data.missing_symbols.map((item) => (
                  <div key={`${item.symbol}-${item.attempted}`} className="flex items-center gap-3">
                    <div className="text-xs font-semibold w-32">{item.symbol}</div>
                    <div className="text-xs text-amber-700 w-40">Attempted: {item.attempted}</div>
                    <input
                      className="flex-1 rounded-lg border border-amber-200 bg-white px-3 py-1 text-sm"
                      placeholder={`New ticker for ${item.symbol}`}
                      value={aliasEdits[item.symbol] ?? data.symbol_aliases?.[item.symbol] ?? ""}
                      onChange={(e) => {
                        const val = e.target.value.trim().toUpperCase();
                        setAliasEdits((prev) => ({ ...prev, [item.symbol]: val }));
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-3">
                <button
                  className="px-4 py-2 rounded-lg text-sm font-semibold bg-amber-600 text-white hover:bg-amber-500"
                  onClick={() => {
                    const aliases = Object.entries(aliasEdits)
                      .filter(([, v]) => v)
                      .map(([from_symbol, to_symbol]) => ({ from_symbol, to_symbol }));
                    if (aliases.length === 0) return;
                    saveAliases(aliases);
                  }}
                >
                  Save All
                </button>
                <span className="text-xs text-amber-700">
                  Example: ZOMATO → ETERNAL, LTI → LTIM, HDFC → HDFCBANK
                </span>
              </div>
            </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
