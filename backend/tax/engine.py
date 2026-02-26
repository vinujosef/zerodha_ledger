import pandas as pd

from .registry import get_tax_calculator
from .types import TaxReportRequest


def calculate_tax_report(
    request: TaxReportRequest,
    trades_df: pd.DataFrame,
    notes_df: pd.DataFrame,
    corporate_actions_df: pd.DataFrame,
) -> dict:
    calculator = get_tax_calculator(request.country_code)
    return calculator.calculate(request, trades_df, notes_df, corporate_actions_df)
