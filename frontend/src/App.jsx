import React, { useState, useEffect } from 'react';
import axios from 'axios';
import DataImportView from './views/DataImportView';
import DashboardView from './views/DashboardView';

const API_URL = 'http://localhost:8000';

function App() {
  const [view, setView] = useState('dashboard');
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
  const [tradeFile, setTradeFile] = useState(null);
  const [contractFiles, setContractFiles] = useState(null);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [stagingId, setStagingId] = useState(null);
  const [holdingsSearch, setHoldingsSearch] = useState('');
  const [realizedSearch, setRealizedSearch] = useState('');

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

  const fetchRealized = async (fyValue) => {
    try {
      const res = await axios.get(`${API_URL}/reports/realized`, { params: { fy: fyValue } });
      setRealized(res.data.rows || []);
    } catch (err) {
      console.error('Realized Error:', err);
    }
  };

  const handlePreview = async () => {
    setLoading(true);
    const formData = new FormData();
    if (tradeFile) formData.append('tradebook', tradeFile);
    if (contractFiles) {
      for (let i = 0; i < contractFiles.length; i += 1) {
        formData.append('contracts', contractFiles[i]);
      }
    }

    try {
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
      fetchRealized(fyValue);
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
    fetchRealized(initialFY);
  }, []);

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
              onClick={() => setView('dashboard')}
              className={`px-4 py-2 rounded-lg text-sm font-semibold ${view === 'dashboard' ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
            >
              Dashboard
            </button>
            <button
              onClick={() => setView('import')}
              className={`px-4 py-2 rounded-lg text-sm font-semibold ${view === 'import' ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
            >
              Data Import
            </button>
          </div>
        </header>

        {view === 'import' && (
          <DataImportView
            loading={loading}
            handlePreview={handlePreview}
            handleCommit={handleCommit}
            preview={preview}
            setTradeFile={setTradeFile}
            setContractFiles={setContractFiles}
          />
        )}

        {view === 'dashboard' && (
          <DashboardView
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
          />
        )}
      </div>
    </div>
  );
}

export default App;
