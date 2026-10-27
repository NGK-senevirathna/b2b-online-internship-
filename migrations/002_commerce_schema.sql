-- B2B Order Management: catalog, stock, carts, orders, invoices and audit trail.
-- Money is stored as integer minor units (cents) to avoid floating-point errors.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

CREATE TABLE products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    sku varchar(40) NOT NULL,
    sku_normalized varchar(40) GENERATED ALWAYS AS (upper(sku)) STORED,
    name varchar(120) NOT NULL,
    description varchar(2000) NOT NULL DEFAULT '',
    price_cents bigint NOT NULL CHECK (price_cents BETWEEN 1 AND 100000000),
    stock_quantity integer NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT products_seller_sku_key UNIQUE (seller_id, sku_normalized)
);

CREATE INDEX products_catalog_idx ON products (status, name);
CREATE INDEX products_seller_idx ON products (seller_id);

CREATE TABLE carts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cart_items (
    cart_id uuid NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
    product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cart_id, product_id)
);

CREATE SEQUENCE order_number_seq START 1000;
CREATE SEQUENCE invoice_number_seq START 1000;

CREATE TABLE orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number varchar(20) NOT NULL UNIQUE DEFAULT ('ORD-' || nextval('order_number_seq')::text),
    buyer_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    status varchar(12) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled')),
    shipping_address varchar(500) NOT NULL,
    subtotal_cents bigint NOT NULL CHECK (subtotal_cents >= 0),
    tax_cents bigint NOT NULL CHECK (tax_cents >= 0),
    total_cents bigint NOT NULL CHECK (total_cents >= 0),
    idempotency_key varchar(64),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT orders_total_consistent CHECK (total_cents = subtotal_cents + tax_cents),
    CONSTRAINT orders_buyer_idempotency_key UNIQUE (buyer_id, idempotency_key)
);

CREATE INDEX orders_buyer_idx ON orders (buyer_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders (status, created_at DESC);

-- Line items snapshot the product name, SKU and price at purchase time.
CREATE TABLE order_items (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id uuid NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
    product_id uuid NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    seller_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    sku varchar(40) NOT NULL,
    name varchar(120) NOT NULL,
    unit_price_cents bigint NOT NULL CHECK (unit_price_cents > 0),
    quantity integer NOT NULL CHECK (quantity > 0),
    line_total_cents bigint NOT NULL,
    CONSTRAINT order_items_line_total_consistent CHECK (line_total_cents = unit_price_cents * quantity)
);

CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_seller_idx ON order_items (seller_id);

CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number varchar(20) NOT NULL UNIQUE DEFAULT ('INV-' || nextval('invoice_number_seq')::text),
    order_id uuid NOT NULL UNIQUE REFERENCES orders (id) ON DELETE RESTRICT,
    buyer_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    status varchar(8) NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'paid', 'void')),
    subtotal_cents bigint NOT NULL CHECK (subtotal_cents >= 0),
    tax_cents bigint NOT NULL CHECK (tax_cents >= 0),
    total_cents bigint NOT NULL CHECK (total_cents >= 0),
    issued_at timestamptz NOT NULL DEFAULT now(),
    due_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
    paid_at timestamptz,
    CONSTRAINT invoices_paid_consistent CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);

CREATE INDEX invoices_buyer_idx ON invoices (buyer_id);

-- Every change to stock is recorded so quantities can be reconciled.
CREATE TABLE stock_movements (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id uuid NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    delta integer NOT NULL CHECK (delta <> 0),
    quantity_after integer NOT NULL CHECK (quantity_after >= 0),
    reason varchar(12) NOT NULL CHECK (reason IN ('initial', 'adjustment', 'order', 'cancellation')),
    note varchar(200),
    order_id uuid REFERENCES orders (id) ON DELETE RESTRICT,
    actor_id uuid REFERENCES users (id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stock_movements_product_idx ON stock_movements (product_id, created_at DESC);

-- Append-only record of security- and business-relevant actions.
CREATE TABLE audit_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id uuid REFERENCES users (id) ON DELETE RESTRICT,
    actor_role varchar(16),
    action varchar(60) NOT NULL,
    entity_type varchar(30) NOT NULL,
    entity_id varchar(64),
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip_address varchar(64),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id);
CREATE INDEX audit_logs_action_idx ON audit_logs (action);

CREATE FUNCTION audit_logs_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only';
END;
$$;

CREATE TRIGGER audit_logs_no_update_delete
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_change();

CREATE TRIGGER audit_logs_no_truncate
    BEFORE TRUNCATE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_reject_change();
