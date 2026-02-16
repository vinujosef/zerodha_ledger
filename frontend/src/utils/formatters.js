export const toNumber = (val) => {
  if (val === null || val === undefined || val === "") return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
};

export const formatIN = (val, { min = 2, max = 2 } = {}) => {
  const n = toNumber(val);
  if (n === null) return "—";
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  }).format(n);
};

export const formatLakhs = (value) => {
  const lakhs = Number(value) / 100000;
  if (!Number.isFinite(lakhs)) return "-";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 }).format(lakhs);
};
