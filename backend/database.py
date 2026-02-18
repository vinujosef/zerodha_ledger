from sqlalchemy import create_engine, Column, Integer, String, Float, Date, DateTime, Boolean
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy.dialects.postgresql import JSONB
import os

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://admin:password@db:5432/zerodha_db")
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class ContractNote(Base):
    __tablename__ = "contract_notes"

    # We treat Date as the unique identifier for the daily bill
    date = Column(Date, primary_key=True, index=True)
    
    total_brokerage = Column(Float, default=0.0)
    total_taxes = Column(Float, default=0.0)
    total_other_charges = Column(Float, default=0.0)
    net_total_paid = Column(Float, default=0.0)
    
    # Removed strict relationship to allow loose coupling

class Trade(Base):
    __tablename__ = "trades"

    id = Column(Integer, primary_key=True, index=True)
    trade_id = Column(String, unique=True, index=True)
    symbol = Column(String, index=True)
    isin = Column(String)
    
    # CHANGED: Removed ForeignKey. This allows trades to exist even if Contract Note is missing.
    date = Column(Date, index=True, nullable=False)
    
    type = Column(String) # 'BUY' or 'SELL'
    quantity = Column(Float)
    price = Column(Float)
    gross_amount = Column(Float)

class UploadBatch(Base):
    __tablename__ = "upload_batches"

    id = Column(String, primary_key=True, index=True)
    created_at = Column(DateTime, index=True)
    committed_at = Column(DateTime, nullable=True)
    is_committed = Column(Boolean, default=False)

    tradebook_filename = Column(String)
    contract_filenames = Column(JSONB)

    trade_rows = Column(JSONB)
    contract_rows = Column(JSONB)
    contract_trade_rows = Column(JSONB)
    contract_charge_rows = Column(JSONB)
    summary = Column(JSONB)

class ContractNoteTrade(Base):
    __tablename__ = "contract_note_trades"

    id = Column(Integer, primary_key=True, index=True)
    contract_note_no = Column(String, nullable=True)
    trade_date = Column(Date, index=True)
    order_no = Column(String, nullable=True)
    order_time = Column(String, nullable=True)
    trade_no = Column(String, nullable=True)
    trade_time = Column(String, nullable=True)
    security_desc = Column(String, nullable=True)
    side = Column(String, nullable=True)  # BUY or SELL
    quantity = Column(Float, nullable=True)
    exchange = Column(String, nullable=True)
    gross_rate = Column(Float, nullable=True)
    net_total = Column(Float, nullable=True)
    sheet_name = Column(String, nullable=True)
    file_name = Column(String, nullable=True)

class ContractNoteCharge(Base):
    __tablename__ = "contract_note_charges"

    id = Column(Integer, primary_key=True, index=True)
    contract_note_no = Column(String, nullable=True)
    trade_date = Column(Date, index=True)
    pay_in_out_obligation = Column(Float, nullable=True)
    taxable_value_of_supply = Column(Float, nullable=True)
    exchange_txn_charges = Column(Float, nullable=True)
    clearing_charges = Column(Float, nullable=True)
    cgst = Column(Float, nullable=True)
    sgst = Column(Float, nullable=True)
    igst = Column(Float, nullable=True)
    stt = Column(Float, nullable=True)
    sebi_txn_tax = Column(Float, nullable=True)
    stamp_duty = Column(Float, nullable=True)
    net_amount_receivable = Column(Float, nullable=True)
    sheet_name = Column(String, nullable=True)
    file_name = Column(String, nullable=True)

class SymbolAlias(Base):
    __tablename__ = "symbol_aliases"

    id = Column(Integer, primary_key=True, index=True)
    from_symbol = Column(String, unique=True, index=True)
    to_symbol = Column(String, index=True)
    active = Column(Boolean, default=True)

class CorporateAction(Base):
    __tablename__ = "corporate_actions"

    id = Column(Integer, primary_key=True, index=True)
    symbol = Column(String, index=True, nullable=False)
    action_type = Column(String, index=True, nullable=False)  # SPLIT, BONUS, MERGER, etc.
    effective_date = Column(Date, index=True, nullable=False)
    ratio_from = Column(Float, nullable=True)
    ratio_to = Column(Float, nullable=True)
    source = Column(String, nullable=True)  # NSE, BSE
    source_ref = Column(String, nullable=True)
    fetched_at = Column(DateTime, nullable=True)
    active = Column(Boolean, default=True)

def init_db():
    Base.metadata.create_all(bind=engine)
