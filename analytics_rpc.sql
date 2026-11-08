-- Phase 5: Advanced Analytics RPCs (Final Robust Version)

-- 1. Ensure clean slate (using exact signatures)
DROP FUNCTION IF EXISTS get_global_growth_stats();
DROP FUNCTION IF EXISTS get_top_performing_shops();
DROP FUNCTION IF EXISTS get_inactive_shops();

-- 1. Global GMV Trends
-- Uses total_amount and explicit casts
CREATE OR REPLACE FUNCTION get_global_growth_stats()
RETURNS TABLE (
    month DATE,
    gmv NUMERIC,
    orders_count BIGINT
) AS $$
    SELECT 
        (date_trunc('month', created_at))::DATE as month,
        COALESCE(SUM(total_amount), 0)::NUMERIC as gmv,
        COUNT(id)::BIGINT as orders_count
    FROM public.sales
    WHERE created_at > (NOW() - INTERVAL '6 months')
    GROUP BY 1
    ORDER BY 1 ASC;
$$ LANGUAGE sql STABLE;

-- 2. Top Performing Shops
CREATE OR REPLACE FUNCTION get_top_performing_shops()
RETURNS TABLE (
    shop_id INTEGER,
    shop_name TEXT,
    gmv NUMERIC,
    order_count BIGINT
) AS $$
    SELECT 
        s.id::INTEGER as shop_id,
        s.name::TEXT as shop_name,
        COALESCE(SUM(sa.total_amount), 0)::NUMERIC as gmv,
        COUNT(sa.id)::BIGINT as order_count
    FROM public.shops s
    JOIN public.sales sa ON s.id = sa.shop_id
    WHERE sa.created_at > (NOW() - INTERVAL '30 days')
    GROUP BY s.id, s.name
    ORDER BY gmv DESC
    LIMIT 10;
$$ LANGUAGE sql STABLE;

-- 3. Inactive Shops
CREATE OR REPLACE FUNCTION get_inactive_shops()
RETURNS TABLE (
    shop_id INTEGER,
    shop_name TEXT,
    last_sale TIMESTAMPTZ,
    owner_phone TEXT
) AS $$
    SELECT 
        s.id::INTEGER as shop_id,
        s.name::TEXT as shop_name,
        MAX(sa.created_at)::TIMESTAMPTZ as last_sale,
        COALESCE(s.phone, 'N/A')::TEXT as owner_phone
    FROM public.shops s
    LEFT JOIN public.sales sa ON s.id = sa.shop_id
    WHERE s.status = 'active'
    GROUP BY s.id, s.name, s.phone
    HAVING MAX(sa.created_at) IS NULL OR MAX(sa.created_at) < (NOW() - INTERVAL '14 days')
    ORDER BY last_sale ASC NULLS FIRST;
$$ LANGUAGE sql STABLE;

