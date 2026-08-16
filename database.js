import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const { Pool } = pg;

const SET_RETURNING_RPCS = new Set([
    'claim_enrichment_job',
    'claim_outbound_events',
    'claim_recording',
    'search_communications',
    'suggest_terms',
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const JSON_COLUMNS = new Set([
    'arguments', 'audit_context', 'correlation', 'metadata', 'participant_identities',
    'payload', 'purpose', 'resolution', 'response', 'result', 'transcript',
]);

function mutationValue(column, value) {
    if (value !== null && Array.isArray(value) && JSON_COLUMNS.has(column)) return JSON.stringify(value);
    return value;
}

function identifier(value) {
    if (!IDENTIFIER.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
    return `"${value}"`;
}

function qualified(value, baseAlias = 't') {
    const jsonText = String(value).match(/^([A-Za-z_][A-Za-z0-9_]*)->>([A-Za-z_][A-Za-z0-9_]*)$/);
    if (jsonText) return `${baseAlias}.${identifier(jsonText[1])}->>'${jsonText[2]}'`;
    const parts = String(value).split('.');
    if (parts.length === 1) return `${baseAlias}.${identifier(parts[0])}`;
    if (parts.length === 2) return `${identifier(parts[0])}.${identifier(parts[1])}`;
    throw new Error(`Unsafe SQL field: ${value}`);
}

function splitSelection(value) {
    const parts = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] === '(') depth += 1;
        if (value[index] === ')') depth -= 1;
        if (value[index] === ',' && depth === 0) {
            parts.push(value.slice(start, index).trim());
            start = index + 1;
        }
    }
    parts.push(value.slice(start).trim());
    return parts.filter(Boolean);
}

function relationSelection(table, token) {
    const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)(!inner)?\((.*)\)$/s);
    if (!match) return null;
    const [, relation, innerMarker, fieldsText] = match;
    const fields = splitSelection(fieldsText || '*');
    const selected = fields.includes('*')
        ? '*'
        : fields.map((field) => identifier(field)).join(', ');

    if (table === 'contacts' && relation === 'contact_config') {
        return {
            expression: `(select row_to_json(embedded) from (select ${selected} from public.contact_config cc where cc.contact_id = t.id limit 1) embedded) as "contact_config"`,
        };
    }
    if (table === 'project_contacts' && relation === 'contacts') {
        return {
            expression: `(select row_to_json(embedded) from (select ${selected} from public.contacts c where c.id = t.contact_id limit 1) embedded) as "contacts"`,
        };
    }
    if (table === 'sms_messages' && relation === 'sms_threads') {
        const expression = fields.includes('*')
            ? 'row_to_json(sms_threads) as "sms_threads"'
            : `json_build_object(${fields.map((field) => `'${field}', sms_threads.${identifier(field)}`).join(', ')}) as "sms_threads"`;
        return {
            expression,
            join: `${innerMarker ? 'inner' : 'left'} join public.sms_threads sms_threads on sms_threads.id = t.thread_id`,
        };
    }
    throw new Error(`Unsupported embedded relation ${table}.${relation}`);
}

function selectionFor(table, value = '*') {
    const expressions = [];
    const joins = new Set();
    for (const token of splitSelection(String(value))) {
        if (token === '*') {
            expressions.push('t.*');
            continue;
        }
        const relation = relationSelection(table, token);
        if (relation) {
            expressions.push(relation.expression);
            if (relation.join) joins.add(relation.join);
            continue;
        }
        expressions.push(`${qualified(token)} as ${identifier(token)}`);
    }
    return { columns: expressions.join(', '), joins: [...joins] };
}

function errorResult(error) {
    return {
        data: null,
        error: {
            message: error?.message || String(error),
            code: error?.code || null,
            details: error?.detail || null,
        },
    };
}

class PostgresQuery {
    constructor(database, table) {
        this.database = database;
        this.table = table;
        identifier(table);
        this.action = 'select';
        this.payload = null;
        this.conflict = null;
        this.ignoreDuplicates = false;
        this.selection = '*';
        this.countMode = null;
        this.head = false;
        this.filters = [];
        this.orders = [];
        this.rowLimit = null;
        this.rowOffset = null;
        this.cardinality = 'many';
        this.returnRows = true;
    }

    select(columns = '*', options = {}) {
        this.selection = columns || '*';
        this.countMode = options.count || this.countMode;
        this.head = options.head === true;
        if (this.action !== 'select') this.returnRows = true;
        return this;
    }

    insert(value) {
        this.action = 'insert';
        this.payload = value;
        this.returnRows = false;
        return this;
    }

    upsert(value, options = {}) {
        this.action = 'upsert';
        this.payload = value;
        this.conflict = options.onConflict || null;
        this.ignoreDuplicates = options.ignoreDuplicates === true;
        this.returnRows = false;
        return this;
    }

    update(value) {
        this.action = 'update';
        this.payload = value;
        this.returnRows = false;
        return this;
    }

    delete() {
        this.action = 'delete';
        this.payload = null;
        this.returnRows = false;
        return this;
    }

    addFilter(column, operator, value) {
        this.filters.push({ column, operator, value });
        return this;
    }

    eq(column, value) { return this.addFilter(column, '=', value); }
    gte(column, value) { return this.addFilter(column, '>=', value); }
    lte(column, value) { return this.addFilter(column, '<=', value); }
    gt(column, value) { return this.addFilter(column, '>', value); }
    lt(column, value) { return this.addFilter(column, '<', value); }
    is(column, value) { return this.addFilter(column, 'is', value); }
    in(column, value) { return this.addFilter(column, 'in', value); }
    contains(column, value) { return this.addFilter(column, 'contains', value); }

    not(column, operator, value) {
        if (operator !== 'is') throw new Error(`Unsupported PostgreSQL adapter not operator: ${operator}`);
        return this.addFilter(column, 'is not', value);
    }

    or(expression) {
        this.filters.push({ operator: 'or', value: expression });
        return this;
    }

    order(column, options = {}) {
        this.orders.push({ column, ascending: options.ascending !== false });
        return this;
    }

    limit(value) {
        this.rowLimit = Math.max(0, Number(value) || 0);
        return this;
    }

    range(from, to) {
        this.rowOffset = Math.max(0, Number(from) || 0);
        this.rowLimit = Math.max(0, Number(to) - this.rowOffset + 1);
        return this;
    }

    single() {
        this.cardinality = 'single';
        this.rowLimit ??= 2;
        return this;
    }

    maybeSingle() {
        this.cardinality = 'maybeSingle';
        this.rowLimit ??= 2;
        return this;
    }

    where(values) {
        const clauses = [];
        for (const filter of this.filters) {
            if (filter.operator === 'or') {
                const alternatives = splitSelection(filter.value).map((item) => {
                    const match = item.match(/^([A-Za-z_][A-Za-z0-9_.]*)\.ilike\.(.*)$/s);
                    if (!match) throw new Error(`Unsupported PostgreSQL adapter OR filter: ${item}`);
                    values.push(match[2].replaceAll('*', '%'));
                    return `${qualified(match[1])} ilike $${values.length}`;
                });
                clauses.push(`(${alternatives.join(' or ')})`);
                continue;
            }

            const field = qualified(filter.column);
            if (filter.operator === 'is' || filter.operator === 'is not') {
                if (filter.value === null) clauses.push(`${field} ${filter.operator} null`);
                else if (filter.value === true || filter.value === false) clauses.push(`${field} ${filter.operator} ${filter.value ? 'true' : 'false'}`);
                else throw new Error(`Unsupported IS value for ${filter.column}`);
                continue;
            }
            if (filter.operator === 'in') {
                const list = Array.isArray(filter.value) ? filter.value : [];
                if (!list.length) clauses.push('false');
                else {
                    values.push(list);
                    clauses.push(`${field} = any($${values.length})`);
                }
                continue;
            }
            values.push(filter.value);
            if (filter.operator === 'contains') clauses.push(`${field} @> $${values.length}`);
            else clauses.push(`${field} ${filter.operator} $${values.length}`);
        }
        return clauses.length ? ` where ${clauses.join(' and ')}` : '';
    }

    async executeSelect() {
        const values = [];
        const selected = selectionFor(this.table, this.selection);
        const from = ` from public.${identifier(this.table)} t${selected.joins.length ? ` ${selected.joins.join(' ')}` : ''}`;
        const where = this.where(values);
        const order = this.orders.length
            ? ` order by ${this.orders.map((item) => `${qualified(item.column)} ${item.ascending ? 'asc' : 'desc'}`).join(', ')}`
            : '';
        const limit = this.rowLimit === null ? '' : ` limit ${Math.trunc(this.rowLimit)}`;
        const offset = this.rowOffset === null ? '' : ` offset ${Math.trunc(this.rowOffset)}`;

        let count = null;
        if (this.countMode === 'exact') {
            const counted = await this.database.query(`select count(*)::bigint as count${from}${where}`, values);
            count = Number(counted.rows[0]?.count || 0);
        }

        if (this.head) return { data: null, error: null, count };
        const result = await this.database.query(`select ${selected.columns}${from}${where}${order}${limit}${offset}`, values);
        return this.finish(result.rows, count);
    }

    mutationRows() {
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
        return rows.map((row) => Object.fromEntries(Object.entries(row || {}).filter(([, value]) => value !== undefined)));
    }

    returningSql() {
        if (!this.returnRows) return '';
        const selection = selectionFor(this.table, this.selection);
        if (selection.joins.length) throw new Error('Embedded selections are not supported on mutation results');
        return ` returning ${selection.columns.replaceAll('t.', '')}`;
    }

    async executeInsert(upsert = false) {
        const rows = this.mutationRows();
        if (!rows.length) return { data: this.returnRows ? [] : null, error: null };
        const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
        if (!columns.length) throw new Error('Cannot insert an empty row');
        const values = [];
        const tuples = rows.map((row) => `(${columns.map((column) => {
            values.push(Object.hasOwn(row, column) ? mutationValue(column, row[column]) : null);
            return `$${values.length}`;
        }).join(', ')})`);
        let conflict = '';
        if (upsert) {
            const conflictColumns = String(this.conflict || '').split(',').map((item) => item.trim()).filter(Boolean);
            if (!conflictColumns.length) throw new Error('PostgreSQL upsert requires onConflict');
            const updates = this.ignoreDuplicates ? [] : columns.filter((column) => !conflictColumns.includes(column));
            conflict = ` on conflict (${conflictColumns.map(identifier).join(', ')}) ${updates.length
                ? `do update set ${updates.map((column) => `${identifier(column)} = excluded.${identifier(column)}`).join(', ')}`
                : 'do nothing'}`;
        }
        const sql = `insert into public.${identifier(this.table)} (${columns.map(identifier).join(', ')}) values ${tuples.join(', ')}${conflict}${this.returningSql()}`;
        const result = await this.database.query(sql, values);
        return this.returnRows ? this.finish(result.rows) : { data: null, error: null };
    }

    async executeUpdate() {
        if (!this.filters.length) throw new Error(`Refusing unfiltered update of ${this.table}`);
        const row = this.mutationRows()[0];
        const columns = Object.keys(row);
        if (!columns.length) throw new Error('Cannot update with an empty row');
        const values = [];
        const set = columns.map((column) => {
            values.push(mutationValue(column, row[column]));
            return `${identifier(column)} = $${values.length}`;
        }).join(', ');
        const where = this.where(values);
        const result = await this.database.query(`update public.${identifier(this.table)} t set ${set}${where}${this.returningSql()}`, values);
        return this.returnRows ? this.finish(result.rows) : { data: null, error: null };
    }

    async executeDelete() {
        if (!this.filters.length) throw new Error(`Refusing unfiltered delete from ${this.table}`);
        const values = [];
        const where = this.where(values);
        const result = await this.database.query(`delete from public.${identifier(this.table)} t${where}${this.returningSql()}`, values);
        return this.returnRows ? this.finish(result.rows) : { data: null, error: null };
    }

    finish(rows, count = null) {
        if (this.cardinality === 'single') {
            if (rows.length !== 1) return errorResult(new Error(`Expected one ${this.table} row, received ${rows.length}`));
            return { data: rows[0], error: null, ...(count === null ? {} : { count }) };
        }
        if (this.cardinality === 'maybeSingle') {
            if (rows.length > 1) return errorResult(new Error(`Expected at most one ${this.table} row, received ${rows.length}`));
            return { data: rows[0] || null, error: null, ...(count === null ? {} : { count }) };
        }
        return { data: rows, error: null, ...(count === null ? {} : { count }) };
    }

    async execute() {
        try {
            if (this.action === 'select') return await this.executeSelect();
            if (this.action === 'insert') return await this.executeInsert(false);
            if (this.action === 'upsert') return await this.executeInsert(true);
            if (this.action === 'update') return await this.executeUpdate();
            if (this.action === 'delete') return await this.executeDelete();
            throw new Error(`Unsupported PostgreSQL action ${this.action}`);
        } catch (error) {
            return errorResult(error);
        }
    }

    then(resolve, reject) {
        return this.execute().then(resolve, reject);
    }
}

export function createPostgresClient(queryable) {
    const database = typeof queryable === 'function' ? { query: queryable } : queryable;
    if (!database || typeof database.query !== 'function') throw new Error('A PostgreSQL query function is required');
    return {
        provider: 'postgres',
        from(table) { return new PostgresQuery(database, table); },
        async rpc(name, args = {}) {
            try {
                identifier(name);
                const entries = Object.entries(args).filter(([, value]) => value !== undefined);
                const values = entries.map(([key, value]) => key === 'p_identities' && Array.isArray(value) ? JSON.stringify(value) : value);
                const parameters = entries.map(([key], index) => `${identifier(key)} => $${index + 1}`).join(', ');
                const result = await database.query(`select * from public.${identifier(name)}(${parameters})`, values);
                if (SET_RETURNING_RPCS.has(name)) return { data: result.rows, error: null };
                const row = result.rows[0];
                return { data: row ? row[Object.keys(row)[0]] : null, error: null };
            } catch (error) {
                return errorResult(error);
            }
        },
    };
}

let client;
let pool;
let activeProvider = null;

export function requestedDatabaseProvider(env = process.env) {
    const explicit = String(env.PERSISTENCE_PROVIDER || '').trim().toLowerCase();
    if (['none', 'off', 'disabled'].includes(explicit)) return null;
    if (['postgres', 'replit', 'replit-postgres'].includes(explicit)) return 'postgres';
    if (explicit === 'supabase') return 'supabase';
    if (explicit) throw new Error(`Unsupported PERSISTENCE_PROVIDER: ${env.PERSISTENCE_PROVIDER}`);
    if (env.SUPABASE_CONFIG_ENABLED === 'true') return 'supabase';
    if (env.DATABASE_URL) return 'postgres';
    return null;
}

export function getDatabase() {
    if (client !== undefined) return client;
    activeProvider = requestedDatabaseProvider();

    if (activeProvider === 'supabase') {
        const credentialed = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
        if (!credentialed) {
            console.warn('Supabase persistence selected but SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.');
            client = null;
        } else {
            client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
        }
    } else if (activeProvider === 'postgres') {
        if (!process.env.DATABASE_URL) {
            console.warn('PostgreSQL persistence selected but DATABASE_URL is missing.');
            client = null;
        } else {
            pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                max: Number(process.env.DATABASE_POOL_MAX) || 10,
                connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS) || 5000,
                idleTimeoutMillis: 30000,
                allowExitOnIdle: true,
            });
            client = createPostgresClient(pool);
        }
    } else {
        client = null;
    }

    console.log(`Communications persistence ${client ? activeProvider : 'disabled'}`);
    return client;
}

export function databaseProvider() {
    if (client === undefined) getDatabase();
    return client ? activeProvider : null;
}

export async function closeDatabase() {
    if (pool) await pool.end();
    pool = null;
    client = undefined;
    activeProvider = null;
}

export function resetDatabaseForTests() {
    pool = null;
    client = undefined;
    activeProvider = null;
}
