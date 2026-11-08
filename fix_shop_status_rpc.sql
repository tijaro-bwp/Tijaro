
CREATE OR REPLACE FUNCTION get_shop_status(p_shop_id INTEGER)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS \$\$
DECLARE
    v_status TEXT;
BEGIN
    SELECT status INTO v_status FROM shops WHERE id = p_shop_id;
    RETURN COALESCE(v_status, 'unknown');
END;
\$\$;

