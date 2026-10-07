/**
 * sensitivity.ts — columns that look personal but are not tagged so.
 *
 * Governance counts sensitive columns by their tags; an untagged model
 * counts none, which reads as "nothing personal here" when it means "nobody
 * looked". This looks: a column whose name says email, phone, date of birth,
 * national or government id, a person's name, an address, an IP address, a
 * card, a bank account or a credential — and that carries no sensitive tag — is a hint,
 * with the tag to give it. A hint, not a verdict: the check that surfaces
 * these is `info`, its fix adds the tag, and `lint-ignore:dm-untagged-sensitive`
 * (on the column or its table) says "looked, not personal".
 *
 * Names are compared in snake form ("EmailAddress" → "email_address"). A
 * key or a reference (`address_id`) names another row, not the data, and a
 * flag about the data (`email_verified`, `has_phone`) is not the data; both
 * are left alone.
 *
 * Zero dependencies, like every contract module.
 */
import { cachedFieldRecords, type FieldDocument, type FieldRef } from "./fields";
import { storesFields } from "./coverage";
import { lintIgnored } from "./lint-ignore";

export interface SensitivityRule {
  /** The tag to suggest — `pii:<category>` matches the default sensitive-tag pattern. */
  tag: string;
  /** What the column looks like, for the message: "an email address". */
  what: string;
  /** Tested against the column name in snake form. */
  pattern: RegExp;
}

/**
 * The name ends with one of these (a trailing number allowed: `address_line2`)
 * — `contact_email` is an email, `email_promotion` is a preference about one.
 */
const w = (alternatives: string) => new RegExp(`(^|_)(${alternatives})(_?\\d+)?$`);

/** In order: the first that matches a name is the hint. */
export const DEFAULT_SENSITIVITY_RULES: readonly SensitivityRule[] = [
  { tag: "secret", what: "a credential", pattern: w("password(_hash|_salt|_digest)?|passwd|pwd|password_hash|api_?key|access_token|refresh_token|auth_token|client_secret|secret_key|private_key") },
  { tag: "pii:email", what: "an email address", pattern: w("e_?mail|email_address|mail_address") },
  { tag: "pii:ip", what: "an IP address", pattern: w("ip|ip_?address|ipv4|ipv6|client_ip|remote_addr") },
  { tag: "pii:phone", what: "a phone number", pattern: w("phone|phone_number|mobile|cell_?phone|telephone|fax|msisdn") },
  { tag: "pii:birth-date", what: "a date of birth", pattern: w("dob|date_of_birth|birth_?date|birthday|birth_dt") },
  { tag: "pii:national-id", what: "a national or tax id", pattern: w("ssn|social_security(_number)?|national_id(_number)?|national_insurance(_number)?|nino|tax_id|tax_number|tin") },
  { tag: "pii:government-id", what: "a passport or licence number", pattern: w("passport(_number|_no)?|drivers?_licen[cs]e(_number|_no)?|licen[cs]e_number") },
  { tag: "pii:name", what: "a person's name", pattern: w("first_?name|last_?name|full_?name|given_name|family_name|surname|middle_name|maiden_name") },
  { tag: "pii:address", what: "a postal address", pattern: w("street(_address)?|address(_line)?(_?\\d)?|addr\\d?|postal_?code|post_?code|zip(_?code)?|home_address|mailing_address") },
  { tag: "pii:card", what: "a payment card number", pattern: w("card_?number|credit_?card(_number)?|cc_?number|pan|cvv|cvc") },
  // Not `account_number`: CRMs and ERPs use it for their own customer and vendor codes.
  { tag: "pii:bank", what: "a bank account", pattern: w("iban|bank_?account(_number)?|routing_?number|sort_?code") },
];

export interface SensitivityHint {
  ref: FieldRef;
  /** The tag the column would carry. */
  tag: string;
  /** "an email address" */
  what: string;
}

export const DEFAULT_SENSITIVE_TAG_PATTERN = /^(pii(:.+)?|sensitive|confidential|secret)$/i;

/** "EmailAddress" → "email_address", "first-name" → "first_name". */
export const snakeName = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

/** A flag or a count about the data, not the data. */
const ABOUT = /(^(is|has)_)|(_(verified|confirmed|opt_?in|opted_in|consent|count|flag|status|type|hash|hashed|valid|id|ids|key)$)/;

/** Untagged columns whose names look personal, with the tag to give each. */
export function sensitivityHints(
  doc: FieldDocument,
  opts: { rules?: readonly SensitivityRule[]; sensitiveTag?: RegExp; isTable?: (node: FieldDocument["nodes"][number]) => boolean } = {},
): SensitivityHint[] {
  const rules = opts.rules ?? DEFAULT_SENSITIVITY_RULES;
  const sensitive = opts.sensitiveTag ?? DEFAULT_SENSITIVE_TAG_PATTERN;
  const records = cachedFieldRecords(doc);
  const out: SensitivityHint[] = [];
  for (const node of doc.nodes.filter(opts.isTable ?? storesFields)) {
    if (lintIgnored(node as { tags?: string[] }, "dm-untagged-sensitive")) continue;
    for (const r of records.get(node.id) ?? []) {
      // A reference names another row; a primary key may well be the data (an email, a phone number).
      if (r.key === "fk" || r.key === "pfk" || r.fk.length) continue;
      if ((r.tags ?? []).some((t) => sensitive.test(t)) || lintIgnored({ tags: r.tags }, "dm-untagged-sensitive")) continue;
      const name = snakeName(r.name);
      // A credential is one whatever its suffix (`password_hash`); anything else
      // named as a flag or a count about the data is not the data.
      const rule = rules.find((x) => x.tag === "secret" && x.pattern.test(name)) ?? (ABOUT.test(name) ? undefined : rules.find((x) => x.pattern.test(name)));
      if (rule) out.push({ ref: { nodeId: node.id, fieldId: r.id }, tag: rule.tag, what: rule.what });
    }
  }
  return out;
}
