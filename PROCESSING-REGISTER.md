# Processing register

Processing register is the scoped, synthetic RoPA-style workbench. It is not a representation of legal compliance or real processing. The old **Processing activities** module is historical and cannot accept mutations.

1. In **Data mapping**, add a fictional activity, one or more datasets it reads or writes, and the systems that host them. Select only linked, active records. Mapped egress is retained as a separate part of the approved snapshot.
2. Approve an applicable purpose term in **Data dictionary** and activate an applicable schedule in **Retention**. A draft references the current approved dictionary editions and active retention schedules, never a free-text substitute.
3. In **Processing register**, draft an entry for the mapped activity. Record its purpose, accountable and stewardship roles, fictional subject/data categories, and each recipient, destination, and safeguard. If the map includes egress, record at least one fictional recipient. An other-region disclosure needs a written safeguard; this does not validate a legal basis or transfer mechanism.
4. Submit the draft for independent publication. A reviewer can return it or publish it with a reason. If linked data changed during review, the reviewer must return the version and have it resubmitted against current references. Accounts that authored, edited, or submitted the version cannot decide it.
5. Download the current approved register, or a specific historical version. Exports contain only approved snapshots and include a SHA-256 content checksum (not a signature). A new draft or a change elsewhere in the workbench never rewrites an approved snapshot.

Scoped analyst/reviewer HTTP endpoints:
- `GET /api/processing-register`: register and eligible references.
- `POST /api/processing-register/entries`: draft with `details`.
- `POST /api/processing-register/entries/:id/{edit,submit,return,publish,revise}`: per-record expected revision, plus details for edit or note for reviewer decisions.
- `GET /api/processing-register/export` for the latest published snapshot of each entry; `GET /api/processing-register/entries/:id/versions/:version/export` for an exact approved snapshot.
