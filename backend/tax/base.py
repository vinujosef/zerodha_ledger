from abc import ABC, abstractmethod
import pandas as pd

from .types import TaxReportRequest


class TaxCalculator(ABC):
    country_code: str

    @abstractmethod
    def calculate(
        self,
        request: TaxReportRequest,
        trades_df: pd.DataFrame,
        notes_df: pd.DataFrame,
        corporate_actions_df: pd.DataFrame,
    ) -> dict:
        raise NotImplementedError
