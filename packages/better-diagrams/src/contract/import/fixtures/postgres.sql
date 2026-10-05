--
-- PostgreSQL database dump (pg_dump --schema-only)
--
SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SELECT pg_catalog.set_config('search_path', '', false);

CREATE SCHEMA sales;

CREATE TYPE public.order_status AS ENUM (
    'new',
    'paid',
    'shipped'
);

CREATE FUNCTION public.touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now(); -- a semicolon inside the body; must not split
  RETURN NEW;
END;
$$;

CREATE TABLE public.customers (
    id integer NOT NULL,
    email character varying(255) NOT NULL,
    full_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.customers IS 'People who buy';
COMMENT ON COLUMN public.customers.email IS 'Login and receipts';

CREATE SEQUENCE public.customers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1;

ALTER TABLE public.customers OWNER TO app;
ALTER SEQUENCE public.customers_id_seq OWNED BY public.customers.id;

CREATE TABLE sales.orders (
    id bigint NOT NULL,
    customer_id integer NOT NULL,
    status public.order_status DEFAULT 'new'::public.order_status NOT NULL,
    total numeric(12,2),
    tags text[]
);

CREATE TABLE sales.order_lines (
    order_id bigint NOT NULL,
    line_no integer NOT NULL,
    product_id integer,
    quantity integer DEFAULT 1 NOT NULL,
    amount numeric(12,2) GENERATED ALWAYS AS (((quantity)::numeric * 1.0)) STORED
);

CREATE TABLE public.products (
    id integer NOT NULL,
    sku text NOT NULL,
    parent_id integer
);

CREATE VIEW sales.order_totals AS
 SELECT orders.id FROM sales.orders;

ALTER TABLE ONLY public.customers ALTER COLUMN id SET DEFAULT nextval('public.customers_id_seq'::regclass);

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY sales.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
ALTER TABLE ONLY sales.order_lines
    ADD CONSTRAINT order_lines_pkey PRIMARY KEY (order_id, line_no);
ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX customers_email_key ON public.customers USING btree (email);
CREATE INDEX orders_customer_idx ON sales.orders USING btree (customer_id);

ALTER TABLE ONLY sales.orders
    ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE RESTRICT;
ALTER TABLE ONLY sales.order_lines
    ADD CONSTRAINT order_lines_order_id_fkey FOREIGN KEY (order_id) REFERENCES sales.orders(id) ON DELETE CASCADE;
ALTER TABLE ONLY sales.order_lines
    ADD CONSTRAINT order_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);
ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.products(id);

GRANT ALL ON SCHEMA public TO app;
