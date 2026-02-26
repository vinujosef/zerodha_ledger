from dataclasses import dataclass
from typing import Optional


@dataclass
class TaxReportRequest:
    country_code: str
    tax_year: int
    method_mode: str = "auto_best_per_sale"
    prior_loss_carryforward: float = 0.0
    include_rows: bool = True
    base_currency: str = "EUR"
    notes: Optional[str] = None
