import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import DataImportView from './views/DataImportView';
import DashboardView from './views/DashboardView';
import { formatIN } from './utils/formatters';

const API_URL = 'http://localhost:8000';

function App() {
  const [view, setView] = useState('dashboard');
  const [dashboardMenuOpen, setDashboardMenuOpen] = useState(false);
  const [dashboardSection, setDashboardSection] = useState('current-holdings');
  const dashboardMenuRef = useRef(null);
  const [data, setData] = useState({
    holdings: [],
    health_issues: [],
    data_warnings: { unmatched_sells: [] },
    realized_pnl: 0,
    net_worth: 0,
    net_worth_yoy: 0,
    fy_list: [],
    missing_symbols: [],
    symbol_aliases: {},
  });
  const [summary, setSummary] = useState({ networth_by_fy: [], charges_by_fy: [] });
  const [realized, setRealized] = useState([]);
  const [aliasEdits, setAliasEdits] = useState({});
  const [fy, setFy] = useState('');
  const [tradeFiles, setTradeFiles] = useState([]);
  const [contractFiles, setContractFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewProgress, setPreviewProgress] = useState(null);
  const [preview, setPreview] = useState(null);
  const [stagingId, setStagingId] = useState(null);
  const [holdingsSearch, setHoldingsSearch] = useState('');
  const [realizedSearch, setRealizedSearch] = useState('');
  const [taxCountries, setTaxCountries] = useState([]);
  const [taxReport, setTaxReport] = useState(null);
  const [taxReportLoading, setTaxReportLoading] = useState(false);
  const [taxReportError, setTaxReportError] = useState('');

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
    } catch (err) {
      console.error('Fetch Error:', err);
    }
  };

  const fetchSummary = async () => {
    try {
      const res = await axios.get(`${API_URL}/reports/summary`);
      setSummary(res.data);
    } catch (err) {
      console.error('Summary Error:', err);
    }
  };

  const fetchRealized = async (fyValue = null) => {
    try {
      const res = await axios.get(
        `${API_URL}/reports/realized`,
        fyValue ? { params: { fy: fyValue } } : undefined
      );
      setRealized(res.data.rows || []);
    } catch (err) {
      console.error('Realized Error:', err);
    }
  };

  const fetchTaxCountries = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/tax/countries`);
      setTaxCountries(res.data.countries || []);
    } catch (err) {
      console.error('Tax countries error:', err);
      setTaxCountries([]);
    }
  }, []);

  const fetchTaxReport = useCallback(async ({
    countryCode = 'FI',
    taxYear = new Date().getFullYear(),
    methodMode = 'auto_best_per_sale',
    priorLossCarryforward = 0,
    includeRows = true,
    baseCurrency = 'EUR',
  } = {}) => {
    setTaxReportLoading(true);
    setTaxReportError('');
    try {
      const payload = {
        country_code: countryCode,
        tax_year: Number(taxYear),
        method_mode: methodMode,
        prior_loss_carryforward: Number(priorLossCarryforward) || 0,
        include_rows: includeRows,
        base_currency: baseCurrency,
      };
      const res = await axios.post(`${API_URL}/tax/report`, payload);
      setTaxReport(res.data);
    } catch (err) {
      console.error('Tax report error:', err);
      const detail = err?.response?.data?.detail || err?.message || 'Failed to load tax report.';
      setTaxReportError(String(detail));
      setTaxReport(null);
    } finally {
      setTaxReportLoading(false);
    }
  }, []);

  const handlePreview = async () => {
    setLoading(true);
    setPreviewLoading(true);
    setPreviewProgress(null);
    const progressId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `preview-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const formData = new FormData();
    formData.append('progress_id', progressId);
    if (tradeFiles.length > 0) {
      for (let i = 0; i < tradeFiles.length; i += 1) {
        formData.append('tradebooks', tradeFiles[i]);
      }
    }
    if (contractFiles.length > 0) {
      for (let i = 0; i < contractFiles.length; i += 1) {
        formData.append('contracts', contractFiles[i]);
      }
    }

    let pollTimer = null;
    try {
      pollTimer = window.setInterval(async () => {
        try {
          const p = await axios.get(`${API_URL}/ingest/progress/${progressId}`);
          setPreviewProgress(p.data);
        } catch (e) {
          // Progress may not be initialized yet; ignore transient polling errors.
        }
      }, 400);
      const response = await axios.post(`${API_URL}/ingest/preview`, formData);
      setPreview(response.data);
      setStagingId(response.data.staging_id);
    } catch (error) {
      console.error('Upload Error:', error);
      if (error.response?.data?.detail) {
        alert(`Upload Failed: ${error.response.data.detail}`);
      } else if (error.message) {
        alert(`Network/Client Error: ${error.message}`);
      } else {
        alert('Unknown Error Occurred.');
      }
    } finally {
      if (pollTimer) {
        window.clearInterval(pollTimer);
      }
      try {
        const p = await axios.get(`${API_URL}/ingest/progress/${progressId}`);
        setPreviewProgress(p.data);
      } catch (e) {
        // ignore
      }
      setPreviewLoading(false);
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
      setTradeFiles([]);
      setContractFiles([]);
      const fyValue = fy || currentFY();
      fetchDashboard(fyValue);
      fetchSummary();
      fetchRealized();
      setView('dashboard');
    } catch (error) {
      console.error('Commit Error:', error);
      if (error.response?.data?.detail) {
        alert(`Commit Failed: ${error.response.data.detail}`);
      } else if (error.message) {
        alert(`Network/Client Error: ${error.message}`);
      } else {
        alert('Unknown Error Occurred.');
      }
    } finally {
      setLoading(false);
    }
  };

  const saveAliases = async (aliases) => {
    try {
      await axios.post(`${API_URL}/symbols/aliases`, { aliases });
      const fyValue = fy || currentFY();
      fetchDashboard(fyValue);
      fetchSummary();
      fetchRealized();
      setAliasEdits({});
    } catch (err) {
      console.error('Alias save error:', err);
      alert('Failed to save symbol aliases.');
    }
  };

  useEffect(() => {
    const initialFY = currentFY();
    setFy(initialFY);
    fetchDashboard(initialFY);
    fetchSummary();
    fetchRealized();
    fetchTaxCountries();
  }, [fetchTaxCountries]);

  const totals = (data.holdings || []).reduce(
    (acc, h) => {
      acc.invested += Number(h.invested_val || 0);
      acc.current += Number(h.current_val || 0);
      return acc;
    },
    { invested: 0, current: 0 },
  );
  const totalPnl = totals.current - totals.invested;
  const totalPnlPct = totals.invested > 0 ? (totalPnl / totals.invested) * 100 : 0;
  const dashboardSectionLabelMap = {
    'current-holdings': 'Current Holdings',
    'past-holding': 'Past Holdings',
    'net-worth': 'Net Worth Over Time',
    charges: 'Charges Paid by Financial Year',
    'tax-report': 'Tax Report by Country',
  };

  useEffect(() => {
    const onDocClick = (event) => {
      if (!dashboardMenuRef.current) return;
      if (!dashboardMenuRef.current.contains(event.target)) {
        setDashboardMenuOpen(false);
      }
    };
    const onEsc = (event) => {
      if (event.key === 'Escape') {
        setDashboardMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="w-full">
        <header className="w-full border-y border-indigo-500/40 bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-600 shadow-sm">
          <div className="flex flex-wrap items-center gap-4 px-4 py-3 lg:px-6">
            <div className="flex items-center gap-3">
              <span className="brand-mark inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/15 text-white shadow-sm ring-1 ring-white/25">
                <svg viewBox="0 0 36 36" className="h-5 w-5" aria-hidden="true">
                  <path
                    className="brand-wave brand-wave-1"
                    d="M4 11.5C7 8.5 10 8.5 13 11.5C16 14.5 19 14.5 22 11.5C25 8.5 28 8.5 31 11.5"
                    stroke="currentColor"
                    strokeWidth="2.8"
                    strokeLinecap="round"
                    fill="none"
                  />
                  <path
                    className="brand-wave brand-wave-2"
                    d="M4 18C7 15 10 15 13 18C16 21 19 21 22 18C25 15 28 15 31 18"
                    stroke="currentColor"
                    strokeWidth="2.8"
                    strokeLinecap="round"
                    fill="none"
                  />
                  <path
                    className="brand-wave brand-wave-3"
                    d="M4 24.5C7 21.5 10 21.5 13 24.5C16 27.5 19 27.5 22 24.5C25 21.5 28 21.5 31 24.5"
                    stroke="currentColor"
                    strokeWidth="2.8"
                    strokeLinecap="round"
                    fill="none"
                  />
                </svg>
              </span>
              <span className="text-lg font-semibold tracking-tight text-white">ClearLedger</span>
            </div>
            <nav className="ml-auto flex items-center gap-3 text-sm font-medium text-white/85">
              <div
                className="relative"
                ref={dashboardMenuRef}
                onMouseEnter={() => setDashboardMenuOpen(true)}
                onMouseLeave={() => setDashboardMenuOpen(false)}
              >
                <button
                  onClick={() => {
                    setDashboardMenuOpen((prev) => !prev);
                  }}
                  className={`nav-link rounded-md px-3 py-1.5 ${view === 'dashboard' ? 'nav-link-active text-white' : 'hover:text-white'}`}
                >
                  <span className="inline-flex items-center gap-1">
                    Dashboard
                    <svg className={`h-4 w-4 transition-transform ${dashboardMenuOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.117l3.71-3.886a.75.75 0 1 1 1.08 1.04l-4.25 4.45a.75.75 0 0 1-1.08 0l-4.25-4.45a.75.75 0 0 1 .02-1.06Z" clipRule="evenodd" />
                    </svg>
                  </span>
                </button>
                {dashboardMenuOpen && (
                  <div className="absolute right-0 top-full z-30 w-72 rounded-xl border border-slate-200 bg-white p-2 text-slate-700 shadow-lg">
                    <button onClick={() => { setDashboardSection('current-holdings'); setView('dashboard'); setDashboardMenuOpen(false); }} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100">Current Holdings</button>
                    <button onClick={() => { setDashboardSection('past-holding'); setView('dashboard'); setDashboardMenuOpen(false); }} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100">Past Holdings</button>
                    <button onClick={() => { setDashboardSection('net-worth'); setView('dashboard'); setDashboardMenuOpen(false); }} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100">Net Worth Over Time</button>
                    <button onClick={() => { setDashboardSection('charges'); setView('dashboard'); setDashboardMenuOpen(false); }} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100">Charges Paid by Financial Year</button>
                    <button onClick={() => { setDashboardSection('tax-report'); setView('dashboard'); setDashboardMenuOpen(false); }} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100">Tax Report by Country</button>
                  </div>
                )}
              </div>
              <button
                onClick={() => {
                  setDashboardMenuOpen(false);
                  setView('import');
                }}
                className={`nav-link rounded-md px-3 py-1.5 ${view === 'import' ? 'nav-link-active text-white' : 'hover:text-white'}`}
              >
                Data Import
              </button>
            </nav>
          </div>
        </header>

        <section className="w-full border-y border-slate-300/60 bg-gradient-to-r from-slate-200/90 via-slate-100/90 to-slate-200/90 px-4 py-3 text-slate-800 lg:px-6">
          <div className="flex flex-wrap items-baseline justify-center gap-x-10 gap-y-2 text-sm text-center">
            <p className="inline-flex items-baseline gap-1.5">
              <span className="text-slate-600">Total Invested:</span>{' '}
              <span className="font-semibold">₹{formatIN(totals.invested)}</span>
            </p>
            <p className="inline-flex items-baseline gap-1.5">
              <span className="text-slate-600">Current Value:</span>{' '}
              <span className="font-semibold">₹{formatIN(totals.current)}</span>
            </p>
            <p className="inline-flex items-baseline gap-1.5">
              <span className="text-slate-600">Total P&L:</span>{' '}
              <span className={`font-semibold ${totalPnl >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                {totalPnl >= 0 ? '+' : ''}₹{formatIN(totalPnl)}
              </span>
              <span className={`ml-2 text-xs ${totalPnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                ({totalPnl >= 0 ? '+' : ''}{totalPnlPct.toFixed(2)}%)
              </span>
            </p>
          </div>
        </section>

      </div>

      <div className="max-w-screen-2xl mx-auto px-4 pt-5 pb-6">
        <main className="brand-canvas mt-5 rounded-[28px] p-4 lg:p-6">
          {view === 'import' && (
          <DataImportView
            loading={loading}
            previewLoading={previewLoading}
            previewProgress={previewProgress}
            handlePreview={handlePreview}
            handleCommit={handleCommit}
              preview={preview}
              tradeFiles={tradeFiles}
              contractFiles={contractFiles}
              setTradeFiles={setTradeFiles}
              setContractFiles={setContractFiles}
            />
          )}

          {view === 'dashboard' && (
            <DashboardView
              dashboardSection={dashboardSection}
              data={data}
              summary={summary}
              realized={realized}
              fy={fy}
              setFy={setFy}
              fetchDashboard={fetchDashboard}
              fetchRealized={fetchRealized}
              aliasEdits={aliasEdits}
              setAliasEdits={setAliasEdits}
              saveAliases={saveAliases}
              holdingsSearch={holdingsSearch}
              setHoldingsSearch={setHoldingsSearch}
              realizedSearch={realizedSearch}
              setRealizedSearch={setRealizedSearch}
              taxCountries={taxCountries}
              taxReport={taxReport}
              taxReportLoading={taxReportLoading}
              taxReportError={taxReportError}
              fetchTaxReport={fetchTaxReport}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
