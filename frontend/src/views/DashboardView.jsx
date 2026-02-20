import React from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Label, LabelList } from 'recharts';
import { formatIN, formatLakhs } from '../utils/formatters';

function SearchInput({ value, onChange, ariaLabel }) {
  return (
    <div className="relative w-64">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="16.65" y1="16.65" x2="21" y2="21" />
        </svg>
      </span>
      <input
        className="w-full rounded-lg border border-slate-300 bg-slate-50 pl-9 pr-9 py-2 text-sm placeholder:text-slate-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-slate-400"
        placeholder="Search symbol..."
        aria-label={ariaLabel}
        value={value}
        onChange={onChange}
      />
      {value && (
        <button
          type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded text-slate-500 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400"
          aria-label={`Clear ${ariaLabel}`}
          onClick={() => onChange({ target: { value: '' } })}
        >
          x
        </button>
      )}
    </div>
  );
}

function DashboardView({
  dashboardSection,
  data,
  summary,
  realized,
  fy,
  setFy,
  fetchDashboard,
  fetchRealized,
  aliasEdits,
  setAliasEdits,
  saveAliases,
  holdingsSearch,
  setHoldingsSearch,
  realizedSearch,
  setRealizedSearch,
}) {
  const years = (summary.networth_by_fy || [])
    .map((e) => String(e.fy || '').replace('FY', ''))
    .map((v) => parseInt(v, 10))
    .filter((v) => Number.isFinite(v));
  const networthTitle = years.length ? `Net Worth Over Time (${Math.min(...years)}-${Math.max(...years)})` : 'Net Worth Over Time';

  const chargesChart = (summary.charges_by_fy || []).map((r) => ({
    ...r,
    charges: Math.abs(Number(r.charges || 0)),
  }));
  const chargesAbsMax = chargesChart.reduce((m, r) => Math.max(m, r.charges || 0), 0);
  const chargesUnit = chargesAbsMax >= 100000 ? 'lakhs' : 'thousands';
  const chargesScale = chargesUnit === 'lakhs' ? 100000 : 1000;
  const formatChargesAxis = (val) => formatIN(Math.abs(Number(val) || 0) / chargesScale);

  const holdingsQuery = holdingsSearch.trim().toUpperCase();
  const realizedQuery = realizedSearch.trim().toUpperCase();
  const showNetWorth = dashboardSection === 'net-worth';
  const showCharges = dashboardSection === 'charges';
  const showCurrentHoldings = dashboardSection === 'current-holdings';
  const showPastHolding = dashboardSection === 'past-holding';

  return (
    <div className="dashboard-surface mt-2 space-y-5">
      {showPastHolding && data.data_warnings?.unmatched_sells?.length > 0 && (
        <div className="surface-block p-4 text-sm text-slate-700">
          <div className="font-semibold text-slate-900">Potentially incorrect realized values detected</div>
          <div className="text-xs text-slate-600 mt-1">
            Some SELL trades do not have enough prior BUY history in the ledger. Until those BUY trades are imported,
            avg buy, sell price adjustments, and realized P&L may be inaccurate.
          </div>
          <div className="mt-3 overflow-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-600 uppercase tracking-wide">
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

      {showNetWorth && (
        <div id="dashboard-net-worth" className="surface-block p-6 h-[430px]">
          <div className="text-sm font-semibold text-slate-900 mb-3">{networthTitle}</div>
          <ResponsiveContainer>
            <LineChart data={summary.networth_by_fy} margin={{ top: 24, right: 30, bottom: 46 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="fy" tickMargin={8} padding={{ left: 8, right: 8 }} angle={-30} textAnchor="end" height={40} />
              <YAxis tickFormatter={formatLakhs} width={60} tickMargin={8}>
                <Label value="Net Worth (₹ in Lakhs)" angle={-90} position="insideLeft" offset={20} dy={50} className="fill-slate-500 text-xs" />
              </YAxis>
              <Tooltip formatter={(value) => [`₹${formatLakhs(value)}L`, 'Net Worth']} labelFormatter={(label) => `Year: ${label}`} />
              <Line type="monotone" dataKey="networth" stroke="#0f172a" strokeWidth={3} dot={{ r: 3 }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {showCharges && (
        <div id="dashboard-charges" className="surface-block p-6 h-[430px]">
          <div className="text-sm font-semibold text-slate-900 mb-3">Charges Paid by Financial Year</div>
          <ResponsiveContainer>
            <BarChart data={chargesChart} margin={{ top: 24, right: 30, left: 24, bottom: 46 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="fy" tickMargin={8} padding={{ left: 8, right: 8 }} angle={-30} textAnchor="end" height={40} />
              <YAxis tickFormatter={formatChargesAxis} width={60} tickMargin={8}>
                <Label
                  value={`Charges (₹ in ${chargesUnit === 'lakhs' ? 'Lakhs' : 'Thousands'})`}
                  angle={-90}
                  position="insideLeft"
                  offset={0}
                  dy={50}
                  className="fill-slate-500 text-xs"
                />
              </YAxis>
              <Tooltip
                formatter={(value) => [`₹${formatIN(Math.abs(value))}`, 'Charges']}
                labelFormatter={(label) => `Year: ${label}`}
              />
              <Bar dataKey="charges" fill="#ef4444" radius={[6, 6, 0, 0]}>
                <LabelList dataKey="charges" position="top" formatter={(value) => `₹${formatIN(value)}`} className="fill-slate-600 text-[10px]" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {showCurrentHoldings && (
        <div id="dashboard-current-holdings" className="surface-block overflow-hidden">
        <div className="px-4 py-3 border-b flex items-center justify-between gap-4">
          <div className="text-sm font-semibold text-slate-900">Current Holdings</div>
          <SearchInput value={holdingsSearch} onChange={(e) => setHoldingsSearch(e.target.value)} ariaLabel="Search current holdings by symbol" />
        </div>
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
            {[...(data.holdings || [])]
              .sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0))
              .map((h) => {
                const sym = String(h.symbol || '').toUpperCase();
                const hit = !holdingsQuery || sym.includes(holdingsQuery);
                return (
                  <tr key={h.symbol} className={hit ? '' : 'opacity-20'}>
                    <td className="px-4 py-3 font-semibold">{h.symbol}</td>
                    <td className="px-4 py-3">{h.quantity}</td>
                    <td className="px-4 py-3">{h.avg_price}</td>
                    <td className="px-4 py-3">{h.cmp}</td>
                    <td className="px-4 py-3">{formatIN(h.invested_val)}</td>
                    <td className="px-4 py-3">{formatIN(h.current_val)}</td>
                    <td className={`px-4 py-3 ${h.pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{formatIN(h.pnl)}</td>
                    <td className={`px-4 py-3 ${h.pnl_pct >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{h.pnl_pct}%</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
        </div>
      )}

      {showPastHolding && (
        <div id="dashboard-past-holding" className="surface-block overflow-hidden">
        <div className="px-4 py-3 border-b flex items-center justify-between gap-4">
          <div className="text-sm font-semibold text-slate-900">Past Holdings (Realized)</div>
          <SearchInput value={realizedSearch} onChange={(e) => setRealizedSearch(e.target.value)} ariaLabel="Search past holdings by symbol" />
        </div>
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
            {realized.map((r, idx) => {
              const sym = String(r.symbol || '').toUpperCase();
              const hit = !realizedQuery || sym.includes(realizedQuery);
              return (
                <tr key={`${r.symbol}-${idx}`} className={hit ? '' : 'opacity-20'}>
                  <td className="px-4 py-3 font-semibold">{r.symbol}</td>
                  <td className="px-4 py-3">{r.sell_date}</td>
                  <td className="px-4 py-3">{r.sell_qty}</td>
                  <td className="px-4 py-3">{r.avg_buy_price}</td>
                  <td className="px-4 py-3">{r.sell_price}</td>
                  <td className={`px-4 py-3 ${r.realized_pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{r.realized_pnl}</td>
                </tr>
              );
            })}
            {realized.length === 0 && (
              <tr>
                <td className="px-4 py-4 text-sm text-slate-400" colSpan="6">No realized trades for this FY.</td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      )}

      {showCurrentHoldings && data.missing_symbols?.length > 0 && (
        <div className="surface-block p-4 text-sm text-slate-800">
          <div className="font-semibold text-slate-900">Price symbols not found</div>
          <div className="text-xs text-slate-600 mt-1">
            These symbols could not be resolved on Yahoo Finance. Map them to their current ticker (without .NS).
          </div>
          <div className="mt-3 space-y-2">
            {data.missing_symbols.map((item) => (
              <div key={`${item.symbol}-${item.attempted}`} className="flex items-center gap-3">
                <div className="text-xs font-semibold w-32">{item.symbol}</div>
                <div className="text-xs text-slate-600 w-40">Attempted: {item.attempted}</div>
                <input
                  className="flex-1 rounded-lg border border-slate-300 bg-white/80 px-3 py-1 text-sm"
                  placeholder={`New ticker for ${item.symbol}`}
                  value={aliasEdits[item.symbol] ?? data.symbol_aliases?.[item.symbol] ?? ''}
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
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-slate-900 text-white hover:bg-slate-800"
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
            <span className="text-xs text-slate-600">Example: ZOMATO {'->'} ETERNAL, LTI {'->'} LTIM, HDFC {'->'} HDFCBANK</span>
          </div>
        </div>
      )}

      {showPastHolding && (
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
            {data.realized_pnl >= 0 ? '+' : ''}₹{formatIN(data.realized_pnl)}
          </span>
        </div>
      </div>
      )}
    </div>
  );
}

export default DashboardView;
