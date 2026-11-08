-- Add low_stock_threshold to categories table
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER DEFAULT NULL;

COMMENT ON COLUMN categories.low_stock_threshold IS
  'Per-category low stock alert threshold. When a product in this category drops to or below this quantity, it triggers a low stock alert. NULL means no category-level threshold is set (falls back to product-level or system default of 10).';
