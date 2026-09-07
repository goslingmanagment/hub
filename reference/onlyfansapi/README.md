# OFAPI schema baseline

`openapi.yaml` is the unmodified official snapshot named and hashed in
`source.json`. It contains OnlyFans and shared OFAPI endpoints. No Fansly
reference or desktop vendored SDK is changed.

`changes.json` compares this snapshot offline with the historical desktop JSON
snapshot identified by hash in `source.json`: 294 current operations versus 266
historical operations; 29 additions, one removal and 95 changed operations.
Each key is HTTP method plus exact path. Changed components compare merged
path/operation parameters (including nested enums), request bodies and response
variants by serialized structure. Descriptive changes are included; the file is
an inspection index, not a claim that every changed operation is incompatible or
implemented by Hub. Common component references are not expanded by this index;
review the complete pinned snapshot for their definitions.

The baseline is committed separately from runtime changes. Current operational
behavior still requires capture-backed fixtures when schema/prose conflict.
