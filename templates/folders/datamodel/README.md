# datamodel — a folder-format example

A small bakery model, written in the `salesforce-datamodel` dialect. It is here
to be opened — Settings ▾ → Templates / folders → **Bakery data model**, or the
editor's **Import folder** button — and to document the format by example.

```
datamodel/
├── schema.json                  root manifest — `bands` marks it, even empty
├── relationships.json           the BUSINESS edges (audit FKs are excluded)
├── metadata/                    cross-cutting; never a node
├── bread/  buildings/  coupons/  customers/  cutlery/
├── ingredients/  people/  products/  recipes/
│                                one OBJECT each: schema.json + object.yaml
├── customers/loyalty-members/   a VIEW: an alias of customers with a filter
└── people/
    ├── forensics.json           attached to the object, never a node
    └── record-types/            a GROUP holding three RECORD TYPES
        ├── chef-individual/  manager-account/  person-account/
```

Five of the six `schema.json` shapes appear here — root, group, object, record
type and view. The sixth, a band, is a folder holding objects; this tree keeps
its nine objects at the root instead, which the importer handles just as well.

What it exercises:

- **Master-detail** (`bread.Recipe__c`) drawn solid with a filled diamond,
  against **lookups** drawn dashed.
- **Audit foreign keys** (`OwnerId` → `User`) absent from `relationships.json`:
  hidden by the default `edges: "business"`, and drawn against an **Outside the
  model** stub with `edges: "all"`.
- **External ids and unique keys** (`Customer__c.External_Key__c`,
  `Product__c.SKU__c`) and a **field hidden from the integration user**
  (`Person__c.Notes__c`) — both in the field grid, neither on a row.
- A **validation rule** on recipes, plus per-object **notes** and **forensics**,
  carried into `data.sf` for an inspector to read.

Nothing here is real. Regenerate or edit it freely.
