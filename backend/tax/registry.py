from .base import TaxCalculator
from .countries import FinlandTaxCalculator


_CALCULATORS = {
    "FI": FinlandTaxCalculator(),
}


def get_tax_calculator(country_code: str) -> TaxCalculator:
    code = (country_code or "").strip().upper()
    calc = _CALCULATORS.get(code)
    if not calc:
        raise ValueError(f"Unsupported country_code: {country_code}")
    return calc


def supported_countries() -> list[str]:
    return sorted(_CALCULATORS.keys())
