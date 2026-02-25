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
  const [networthOrder, setNetworthOrder] = React.useState('asc');
  const [chargesOrder, setChargesOrder] = React.useState('asc');
  const [holdingsSortKey, setHoldingsSortKey] = React.useState('pnl');
  const [holdingsSortDir, setHoldingsSortDir] = React.useState('desc');
  const [realizedSortKey, setRealizedSortKey] = React.useState('sell_date');
  const [realizedSortDir, setRealizedSortDir] = React.useState('asc');
  const [pastViewMode, setPastViewMode] = React.useState('table');
  const currentYear = new Date().getFullYear();
  const [analyticsRange, setAnalyticsRange] = React.useState(`year-${currentYear}`);
  const [customFrom, setCustomFrom] = React.useState('');
  const [customTo, setCustomTo] = React.useState('');

  const toFyNumber = (fyVal) => Number(String(fyVal || '').replace('FY', '')) || 0;
  const networthData = [...(summary.networth_by_fy || [])].sort((a, b) => (
    networthOrder === 'asc' ? toFyNumber(a.fy) - toFyNumber(b.fy) : toFyNumber(b.fy) - toFyNumber(a.fy)
  ));
  const chargesChartSorted = [...chargesChart].sort((a, b) => (
    chargesOrder === 'asc' ? toFyNumber(a.fy) - toFyNumber(b.fy) : toFyNumber(b.fy) - toFyNumber(a.fy)
  ));

  const holdingsRows = [...(data.holdings || [])]
    .sort((a, b) => {
      const direction = holdingsSortDir === 'asc' ? 1 : -1;
      if (holdingsSortKey === 'symbol') {
        return direction * String(a.symbol || '').localeCompare(String(b.symbol || ''));
      }
      return direction * ((Number(a[holdingsSortKey] || 0)) - (Number(b[holdingsSortKey] || 0)));
    });

  const handleHoldingsSort = (key) => {
    if (holdingsSortKey === key) {
      setHoldingsSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setHoldingsSortKey(key);
    setHoldingsSortDir(key === 'symbol' ? 'asc' : 'desc');
  };

  const holdingsSortMark = (key) => {
    if (holdingsSortKey !== key) return '';
    return holdingsSortDir === 'asc' ? '↑' : '↓';
  };

  const realizedRows = [...(realized || [])]
    .sort((a, b) => {
      const direction = realizedSortDir === 'asc' ? 1 : -1;
      if (realizedSortKey === 'symbol') {
        return direction * String(a.symbol || '').localeCompare(String(b.symbol || ''));
      }
      if (realizedSortKey === 'sell_date') {
        const da = new Date(a.sell_date || 0).getTime();
        const db = new Date(b.sell_date || 0).getTime();
        return direction * (da - db);
      }
      return direction * (Number(a[realizedSortKey] || 0) - Number(b[realizedSortKey] || 0));
    });
  const filteredRealizedRows = realizedQuery
    ? realizedRows.filter((r) => String(r.symbol || '').toUpperCase().includes(realizedQuery))
    : realizedRows;

  const today = new Date();
  // Build year chips from the most recent 4 calendar years, but only show years that exist in realized data.
  const realizedYears = new Set((realized || []).map((r) => new Date(`${r.sell_date}T00:00:00`).getFullYear()).filter((y) => Number.isFinite(y)));
  const analyticsYearOptions = [0, 1, 2, 3]
    .map((delta) => currentYear - delta)
    .filter((year) => realizedYears.has(year));
  // Keep selected year valid when data changes (fallback to first available year, else "all").
  React.useEffect(() => {
    if (analyticsRange.startsWith('year-')) {
      const selectedYear = Number(analyticsRange.replace('year-', ''));
      if (!analyticsYearOptions.includes(selectedYear)) {
        setAnalyticsRange(analyticsYearOptions.length > 0 ? `year-${analyticsYearOptions[0]}` : 'all');
      }
    }
  }, [analyticsRange, analyticsYearOptions]);

  const getPeriodStart = () => {
    // "year-YYYY" maps to full calendar-year boundaries.
    if (analyticsRange.startsWith('year-')) {
      const selectedYear = Number(analyticsRange.replace('year-', ''));
      if (!Number.isFinite(selectedYear)) return null;
      return {
        from: new Date(selectedYear, 0, 1, 0, 0, 0),
        to: new Date(selectedYear, 11, 31, 23, 59, 59),
      };
    }
    // Custom range requires valid from/to dates; invalid range intentionally returns no rows.
    if (analyticsRange === 'custom') {
      if (!customFrom || !customTo) return null;
      const from = new Date(`${customFrom}T00:00:00`);
      const to = new Date(`${customTo}T23:59:59`);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return null;
      return { from, to };
    }
    return null;
  };

  const periodStart = getPeriodStart();
  const analyticsRows = (realized || []).filter((r) => {
    const d = new Date(`${r.sell_date}T00:00:00`);
    if (Number.isNaN(d.getTime())) return false;
    if (!periodStart) return analyticsRange === 'custom' ? false : true;
    if (periodStart.from && periodStart.to) return d >= periodStart.from && d <= periodStart.to;
    return d >= periodStart && d <= today;
  });

  const analyticsKpis = analyticsRows.reduce((acc, r) => {
    const pnl = Number(r.realized_pnl || 0);
    acc.net += pnl;
    if (pnl >= 0) {
      acc.gain += pnl;
    } else {
      acc.loss += Math.abs(pnl);
    }
    return acc;
  }, { gain: 0, loss: 0, net: 0 });
  const closedTrades = analyticsRows.length;

  const trendMap = analyticsRows.reduce((acc, r) => {
    const dateObj = new Date(`${r.sell_date}T00:00:00`);
    const key = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
    const label = dateObj.toLocaleString('en-US', { month: 'short', year: 'numeric' });
    const pnl = Number(r.realized_pnl || 0);
    if (!acc[key]) acc[key] = { key, label, gain: 0, loss: 0, net: 0 };
    if (pnl >= 0) acc[key].gain += pnl;
    else acc[key].loss += pnl;
    acc[key].net += pnl;
    return acc;
  }, {});
  const trendData = Object.values(trendMap).sort((a, b) => a.key.localeCompare(b.key));
  const analyticsAxisMaxAbs = trendData.reduce(
    (m, p) => Math.max(m, Math.abs(Number(p.gain || 0)), Math.abs(Number(p.loss || 0)), Math.abs(Number(p.net || 0))),
    0,
  );
  const analyticsAxisUnit = analyticsAxisMaxAbs >= 10000000
    ? 'crores'
    : analyticsAxisMaxAbs >= 100000
      ? 'lacs'
      : 'thousands';
  const analyticsAxisScale = analyticsAxisUnit === 'crores' ? 10000000 : analyticsAxisUnit === 'lacs' ? 100000 : 1000;
  const formatAnalyticsAxisTick = (value) => {
    const scaled = Number(value || 0) / analyticsAxisScale;
    const rounded = Math.abs(scaled) >= 10 ? scaled.toFixed(1) : scaled.toFixed(2);
    return Number(rounded).toString();
  };

  const symbolPnlMap = analyticsRows.reduce((acc, r) => {
    const symbol = String(r.symbol || '');
    const pnl = Number(r.realized_pnl || 0);
    acc[symbol] = (acc[symbol] || 0) + pnl;
    return acc;
  }, {});
  const symbolPnlRows = Object.entries(symbolPnlMap).map(([symbol, pnl]) => ({ symbol, pnl }));
  const allGainers = symbolPnlRows.filter((r) => r.pnl > 0).sort((a, b) => b.pnl - a.pnl);
  const allLosers = symbolPnlRows.filter((r) => r.pnl < 0).sort((a, b) => a.pnl - b.pnl);

  const handleRealizedSort = (key) => {
    if (realizedSortKey === key) {
      setRealizedSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setRealizedSortKey(key);
    setRealizedSortDir('asc');
  };

  const realizedSortMark = (key) => {
    if (realizedSortKey !== key) return '';
    return realizedSortDir === 'asc' ? '↑' : '↓';
  };

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
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <div className="text-3xl font-semibold tracking-tight text-slate-900">{networthTitle}</div>
            </div>
            <select
              value={networthOrder}
              onChange={(e) => setNetworthOrder(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs"
            >
              <option value="asc">FY Asc</option>
              <option value="desc">FY Desc</option>
            </select>
          </div>
          {networthData.length > 0 ? (
          <ResponsiveContainer>
            <LineChart data={networthData} margin={{ top: 24, right: 30, bottom: 46 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="fy" tickMargin={8} padding={{ left: 8, right: 8 }} angle={-30} textAnchor="end" height={40} />
              <YAxis tickFormatter={formatLakhs} width={60} tickMargin={8}>
                <Label value="Net Worth (₹ in Lakhs)" angle={-90} position="insideLeft" offset={20} dy={50} className="fill-slate-500 text-xs" />
              </YAxis>
              <Tooltip formatter={(value) => [`₹${formatLakhs(value)}L`, 'Net Worth']} labelFormatter={(label) => `Year: ${label}`} />
              <Line type="monotone" dataKey="networth" stroke="#0f172a" strokeWidth={3} dot={{ r: 3 }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
          ) : (
            <div className="h-[320px] grid place-items-center text-sm text-slate-500">No net worth data available yet.</div>
          )}
        </div>
      )}

      {showCharges && (
        <div id="dashboard-charges" className="surface-block p-6 h-[430px]">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <div className="text-3xl font-semibold tracking-tight text-slate-900">Charges Paid by Financial Year</div>
            </div>
            <select
              value={chargesOrder}
              onChange={(e) => setChargesOrder(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs"
            >
              <option value="asc">FY Asc</option>
              <option value="desc">FY Desc</option>
            </select>
          </div>
          {chargesChartSorted.length > 0 ? (
          <ResponsiveContainer>
            <BarChart data={chargesChartSorted} margin={{ top: 24, right: 30, left: 24, bottom: 46 }}>
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
          ) : (
            <div className="h-[320px] grid place-items-center text-sm text-slate-500">No charges data available yet.</div>
          )}
        </div>
      )}

      {showCurrentHoldings && (
        <div id="dashboard-current-holdings" className="surface-block overflow-hidden">
        <div className="px-4 py-3 border-b flex items-center justify-between gap-4">
          <div>
            <div className="text-3xl font-semibold tracking-tight text-slate-900">Current Holdings</div>
          </div>
          <div className="flex items-center gap-2">
            <SearchInput value={holdingsSearch} onChange={(e) => setHoldingsSearch(e.target.value)} ariaLabel="Search current holdings by symbol" />
          </div>
        </div>
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-widest text-slate-400 border-b bg-slate-50">
            <tr className="text-left">
              <th className="px-4 py-3 cursor-pointer select-none hover:text-slate-700" onClick={() => handleHoldingsSort('symbol')}>
                <span className="inline-flex items-center gap-1">
                  Symbol <span className="text-[10px]">{holdingsSortMark('symbol')}</span>
                </span>
              </th>
              <th className="px-4 py-3 cursor-pointer select-none hover:text-slate-700" onClick={() => handleHoldingsSort('quantity')}>
                <span className="inline-flex items-center gap-1">
                  Qty <span className="text-[10px]">{holdingsSortMark('quantity')}</span>
                </span>
              </th>
              <th className="px-4 py-3">Avg Price</th>
              <th className="px-4 py-3">LTP</th>
              <th className="px-4 py-3 cursor-pointer select-none hover:text-slate-700" onClick={() => handleHoldingsSort('invested_val')}>
                <span className="inline-flex items-center gap-1">
                  Invested <span className="text-[10px]">{holdingsSortMark('invested_val')}</span>
                </span>
              </th>
              <th className="px-4 py-3 cursor-pointer select-none hover:text-slate-700" onClick={() => handleHoldingsSort('current_val')}>
                <span className="inline-flex items-center gap-1">
                  Current <span className="text-[10px]">{holdingsSortMark('current_val')}</span>
                </span>
              </th>
              <th className="px-4 py-3 cursor-pointer select-none hover:text-slate-700" onClick={() => handleHoldingsSort('pnl')}>
                <span className="inline-flex items-center gap-1">
                  P&amp;L <span className="text-[10px]">{holdingsSortMark('pnl')}</span>
                </span>
              </th>
              <th className="px-4 py-3 cursor-pointer select-none hover:text-slate-700" onClick={() => handleHoldingsSort('pnl_pct')}>
                <span className="inline-flex items-center gap-1">
                  % <span className="text-[10px]">{holdingsSortMark('pnl_pct')}</span>
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {holdingsRows.length > 0 ? holdingsRows.map((h) => {
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
              }) : (
                <tr>
                  <td className="px-4 py-6 text-sm text-slate-400" colSpan="8">No holdings match the selected filters.</td>
                </tr>
              )}
          </tbody>
        </table>
        </div>
      )}

      {showPastHolding && (
        <div id="dashboard-past-holding" className="surface-block overflow-hidden">
        <div className="px-4 py-3 border-b flex items-center justify-between gap-4">
          <div>
            <div className="text-3xl font-semibold tracking-tight text-slate-900">Past Holdings</div>
          </div>
          <div className="flex items-center gap-2">
            {pastViewMode === 'table' && (
              <SearchInput value={realizedSearch} onChange={(e) => setRealizedSearch(e.target.value)} ariaLabel="Search past holdings by symbol" />
            )}
            {/* Table shows row-level details; Analytics shows period KPIs, trend and ranked lists. */}
            <div className="inline-flex rounded-lg border border-slate-300 bg-slate-50 p-1 text-xs font-semibold">
              <button
                type="button"
                onClick={() => setPastViewMode('table')}
                className={`rounded-md px-3 py-1.5 ${pastViewMode === 'table' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
              >
                Table
              </button>
              <button
                type="button"
                onClick={() => setPastViewMode('analytics')}
                className={`rounded-md px-3 py-1.5 ${pastViewMode === 'analytics' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
              >
                Analytics
              </button>
            </div>
          </div>
        </div>
        {pastViewMode === 'table' ? (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-widest text-slate-400 border-b bg-slate-50">
              <tr className="text-left">
                <th className="px-4 py-3 cursor-pointer select-none hover:text-slate-700" onClick={() => handleRealizedSort('symbol')}>
                  <span className="inline-flex items-center gap-1">
                    Symbol <span className="text-[10px]">{realizedSortMark('symbol')}</span>
                  </span>
                </th>
                <th className="px-4 py-3 cursor-pointer select-none hover:text-slate-700" onClick={() => handleRealizedSort('sell_date')}>
                  <span className="inline-flex items-center gap-1">
                    Sell Date <span className="text-[10px]">{realizedSortMark('sell_date')}</span>
                  </span>
                </th>
                <th className="px-4 py-3">Qty</th>
                <th className="px-4 py-3">Avg Buy</th>
                <th className="px-4 py-3">Sell Price</th>
                <th className="px-4 py-3 cursor-pointer select-none hover:text-slate-700" onClick={() => handleRealizedSort('realized_pnl')}>
                  <span className="inline-flex items-center gap-1">
                    Realized P&amp;L <span className="text-[10px]">{realizedSortMark('realized_pnl')}</span>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredRealizedRows.length > 0 ? filteredRealizedRows.map((r, idx) => (
                  <tr key={`${r.symbol}-${idx}`}>
                    <td className="px-4 py-3 font-semibold">{r.symbol}</td>
                    <td className="px-4 py-3">{r.sell_date}</td>
                    <td className="px-4 py-3">{r.sell_qty}</td>
                    <td className="px-4 py-3">{r.avg_buy_price}</td>
                    <td className="px-4 py-3">{r.sell_price}</td>
                    <td className={`px-4 py-3 ${r.realized_pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{r.realized_pnl}</td>
                  </tr>
              )) : (
                <tr>
                  <td className="px-4 py-4 text-sm text-slate-400" colSpan="6">No past holdings match the selected filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <div className="p-4 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {[...analyticsYearOptions.map((year) => [`year-${year}`, String(year)]), ['all', 'All'], ['custom', 'Custom']].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setAnalyticsRange(key)}
                  className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${analyticsRange === key ? 'border-slate-700 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'}`}
                >
                  {label}
                </button>
              ))}
              {analyticsRange === 'custom' && (
                <div className="flex items-center gap-2 text-xs">
                  <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5" />
                  <span className="text-slate-500">to</span>
                  <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5" />
                </div>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                <div className="text-xs uppercase tracking-wide text-emerald-700">Total Gain</div>
                <div className="text-lg font-semibold text-emerald-700">+₹{formatIN(analyticsKpis.gain)}</div>
              </div>
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
                <div className="text-xs uppercase tracking-wide text-rose-700">Total Loss</div>
                <div className="text-lg font-semibold text-rose-700">-₹{formatIN(analyticsKpis.loss)}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-xs uppercase tracking-wide text-slate-600">Net Realized P&amp;L</div>
                <div className={`text-lg font-semibold ${analyticsKpis.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {analyticsKpis.net >= 0 ? '+' : ''}₹{formatIN(analyticsKpis.net)}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-xs uppercase tracking-wide text-slate-600">Closed Trades</div>
                <div className="text-lg font-semibold text-slate-900">{closedTrades}</div>
              </div>
            </div>

            {trendData.length > 0 ? (
              <div className="h-[280px] rounded-lg border border-slate-200 bg-white p-3">
                <ResponsiveContainer>
                  <BarChart data={trendData} margin={{ top: 10, right: 16, left: 36, bottom: 30 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="label" angle={-30} textAnchor="end" height={50} tickMargin={8} />
                    <YAxis
                      width={84}
                      tickFormatter={formatAnalyticsAxisTick}
                      axisLine={{ stroke: '#94a3b8' }}
                      tickLine={{ stroke: '#94a3b8' }}
                      tick={{ fill: '#475569', fontSize: 12 }}
                    >
                      <Label
                        value={`Realized P&L (in ${analyticsAxisUnit})`}
                        angle={-90}
                        position="insideLeft"
                        offset={0}
                        dy={72}
                        className="fill-slate-500 text-xs"
                      />
                    </YAxis>
                    <Tooltip
                      formatter={(value, name) => {
                        if (name === 'gain') return [`+₹${formatIN(value)}`, 'Gain'];
                        if (name === 'loss') return [`-₹${formatIN(Math.abs(value))}`, 'Loss'];
                        return [`₹${formatIN(value)}`, 'Net'];
                      }}
                    />
                    <Bar dataKey="gain" fill="#16a34a" name="gain" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="loss" fill="#e11d48" name="loss" radius={[4, 4, 0, 0]} />
                    <Line type="monotone" dataKey="net" stroke="#0f172a" strokeWidth={2} dot={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
                No realized data in the selected period.
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="mb-2 text-sm font-semibold text-slate-900">All Gains</div>
                {allGainers.length > 0 ? (
                  <div className="space-y-1">
                    {allGainers.map((row) => (
                      <div key={`gain-${row.symbol}`} className="flex items-center justify-between text-sm">
                        <span className="font-medium text-slate-800">{row.symbol}</span>
                        <span className="font-semibold text-emerald-700">+₹{formatIN(row.pnl)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-slate-500">No gainers for this period.</div>
                )}
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="mb-2 text-sm font-semibold text-slate-900">All Losses</div>
                {allLosers.length > 0 ? (
                  <div className="space-y-1">
                    {allLosers.map((row) => (
                      <div key={`loss-${row.symbol}`} className="flex items-center justify-between text-sm">
                        <span className="font-medium text-slate-800">{row.symbol}</span>
                        <span className="font-semibold text-rose-700">-₹{formatIN(Math.abs(row.pnl))}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-slate-500">No losers for this period.</div>
                )}
              </div>
            </div>
          </div>
        )}
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

    </div>
  );
}

export default DashboardView;
