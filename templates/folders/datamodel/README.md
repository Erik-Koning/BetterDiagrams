# datamodel — a folder-format example

A small bakery model, written in the `datamodel` dialect. It is here to be
opened — Settings ▾ → Templates / folders → **Bakery data model**, or the
editor's **Import folder** button — and to document the format by example.

```
datamodel/
├── schema.json                  root manifest — `bands` marks it, even empty
├── relationships.json           the BUSINESS edges (audit FKs are excluded)
├── metadata/                    cross-cutting; never a node
├── bread/  buildings/  coupons/  customers/  cutlery/
├── ingredients/  people/  products/  recipes/
│                                one ENTITY each: schema.json + entity.yaml
├── customers/loyalty-members/   a VIEW: an alias of customers with a filter
└── people/
    ├── forensics.json           attached to the entity, never a node
    └── record-types/            a GROUP holding three RECORD TYPES
        ├── chef/  customer/  manager/
```

Five of the six `schema.json` shapes appear here — root, group, entity, record
type and view. The sixth, a band, is a folder holding entities; this tree keeps
its nine entities at the root instead, which the importer handles just as well.
A folder with no `schema.json` at all that holds entities would read as a
group, so a tree can also lean on its directory structure alone.

What it exercises:

- **Composition** (`bread.recipe_id`) drawn solid with a filled diamond,
  against **references** drawn dashed.
- **Audit foreign keys** (`owner_id` → `user`) absent from `relationships.json`:
  hidden by the default `edges: "business"`, and drawn against an **Outside the
  model** stub with `edges: "all"`.
- **External ids and unique keys** (`customer.external_key`, `product.sku`)
  and a **field hidden from the reader** (`person.notes`, `visible: false`) —
  both in the field grid, neither on a row.
- A **validation rule** on recipes, plus per-entity **notes** and **forensics**,
  carried into `data.model` for an inspector to read.

Nothing here is real. Regenerate or edit it freely.
