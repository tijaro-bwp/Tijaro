-- Table: public.audit_logs

-- DROP TABLE IF EXISTS public.audit_logs;

CREATE TABLE IF NOT EXISTS public.audit_logs
(
    id uuid NOT NULL DEFAULT uuid_generate_v4(),
    created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
    actor_id uuid, -- ID of the user performing the action (superadmin or specific user)
    actor_email character varying COLLATE pg_catalog."default",
    action_type character varying COLLATE pg_catalog."default" NOT NULL, -- e.g., 'LOGIN', 'SUSPEND_SHOP', 'ACTIVATE_SHOP', 'BILLING_UPDATED'
    target_type character varying COLLATE pg_catalog."default", -- e.g., 'SHOP', 'USER', 'SYSTEM'
    target_id character varying COLLATE pg_catalog."default", -- ID of the affected entity
    details jsonb, -- Additional payload/context
    ip_address character varying COLLATE pg_catalog."default",
    CONSTRAINT audit_logs_pkey PRIMARY KEY (id)
)

TABLESPACE pg_default;

ALTER TABLE IF EXISTS public.audit_logs
    OWNER to postgres;

ALTER TABLE IF EXISTS public.audit_logs
    ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.audit_logs TO anon;
GRANT ALL ON TABLE public.audit_logs TO authenticated;
GRANT ALL ON TABLE public.audit_logs TO postgres;
GRANT ALL ON TABLE public.audit_logs TO service_role;

-- Policies
CREATE POLICY "Enable insert for authenticated users only"
    ON public.audit_logs
    AS PERMISSIVE
    FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "Enable read access for all users"
    ON public.audit_logs
    AS PERMISSIVE
    FOR SELECT
    TO public
    USING (true);

-- Indexes for faster querying
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_type ON public.audit_logs(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target_id ON public.audit_logs(target_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs(created_at DESC);
