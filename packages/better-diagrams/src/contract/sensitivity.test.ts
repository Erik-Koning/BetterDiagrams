/**
 * sensitivity.test.ts — columns that look personal but are not tagged: the
 * hints, what they leave alone, the check and its fix, and governance.
 */
import { describe, expect, it } from "vitest";
import { sensitivityHints } from "./sensitivity";
import { lintTemplate } from "./lint";
import { governanceReport } from "./dictionary";
import type { DiagramTemplate } from "./schema";
import type { FieldDocument } from "./fields";

const table = (id: string, fields: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  id,
  label: id[0]!.toUpperCase() + id.slice(1),
  kind: "table",
  fields: fields.map((f) => ({ id: String(f.name), ...f })),
  ...over,
});

const DOC = {
  nodes: [
    table("customers", [
      { name: "id", key: "pk" },
      { name: "EmailAddress" },
      { name: "mobile" },
      { name: "date_of_birth" },
      { name: "first_name" },
      { name: "street_address" },
      { name: "postcode" },
      { name: "ssn", tags: ["pii:national-id"] },
      { name: "address_id", key: "fk" },
      { name: "email_verified" },
      { name: "has_phone" },
      { name: "name" },
      { name: "iban", tags: ["lint-ignore:dm-untagged-sensitive"] },
    ]),
    table("sessions", [{ name: "id", key: "pk" }, { name: "client_ip" }], { data: { model: { fields: [{ name: "card_number" }] } } }),
    table("audit", [{ name: "ip_address" }], { tags: ["lint-ignore:dm-untagged-sensitive"] }),
  ],
  edges: [],
} as unknown as FieldDocument;

describe("sensitivityHints", () => {
  it("names the personal-looking columns with no sensitive tag, and the tag each would take", () => {
    expect(sensitivityHints(DOC).map((h) => [`${h.ref.nodeId}.${h.ref.fieldId}`, h.tag])).toEqual([
      ["customers.EmailAddress", "pii:email"],
      ["customers.mobile", "pii:phone"],
      ["customers.date_of_birth", "pii:birth-date"],
      ["customers.first_name", "pii:name"],
      ["customers.street_address", "pii:address"],
      ["customers.postcode", "pii:address"],
      ["sessions.client_ip", "pii:ip"],
      ["sessions.card_number", "pii:card"],
    ]);
  });

  it("leaves alone a tagged column, a key or reference, a flag about the data, a plain `name`, and what is ignored", () => {
    const hinted = new Set(sensitivityHints(DOC).map((h) => h.ref.fieldId));
    for (const name of ["ssn", "address_id", "email_verified", "has_phone", "name", "iban", "ip_address"]) expect(hinted.has(name), name).toBe(false);
  });
});

describe("names that only look personal, and personal data that is a key", () => {
  it("as AdventureWorks writes them", () => {
    const doc = {
      nodes: [
        table("person", [{ name: "BusinessEntityID", key: "pk" }, { name: "EmailPromotion" }, { name: "AccountNumber" }]),
        table("order", [{ name: "SalesOrderID", key: "pk" }, { name: "CreditCardApprovalCode" }, { name: "AccountNumber" }]),
        table("person_phone", [{ name: "PhoneNumber", key: "pk" }, { name: "PhoneNumberTypeID", key: "pfk" }]),
        table("password", [{ name: "PasswordHash" }, { name: "PasswordSalt" }]),
        table("employee", [{ name: "NationalIDNumber" }, { name: "AddressLine2" }]),
      ],
      edges: [],
    } as unknown as FieldDocument;
    expect(sensitivityHints(doc).map((h) => `${h.ref.fieldId}=${h.tag}`)).toEqual([
      "PhoneNumber=pii:phone",
      "PasswordHash=secret",
      "PasswordSalt=secret",
      "NationalIDNumber=pii:national-id",
      "AddressLine2=pii:address",
    ]);
  });
});

describe("the check and its fix", () => {
  it("is an info finding; a drawn row gets a Tag fix, a column only the data knows does not", () => {
    const findings = lintTemplate(DOC as unknown as DiagramTemplate).filter((f) => f.rule === "dm-untagged-sensitive");
    expect(findings[0]).toMatchObject({
      severity: "info",
      message: '"Customers.EmailAddress" looks like an email address but carries no sensitive tag',
      fields: [{ nodeId: "customers", fieldId: "EmailAddress" }],
      fix: { kind: "tag-field", label: "Tag pii:email", field: { nodeId: "customers", fieldId: "EmailAddress" }, tag: "pii:email" },
    });
    expect(findings.find((f) => f.fields?.[0]?.fieldId === "card_number")!.fix).toBeUndefined();
  });

  it("feeds governance's list of what to look at", () => {
    const report = governanceReport(DOC);
    expect(report.suggested.map((s) => s.ref.fieldId)).toContain("EmailAddress");
    expect(report.sensitivity.map((s) => s.tag)).toEqual(["pii:national-id"]);
  });
});
