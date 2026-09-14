# Evidence packaging

Original stdout/stderr bytes are retained in lossless `.log.gz` archives with
mtime zero. Each receipt's `log` names the original stream; `logArchive` names
the committed archive. `logSha256` hashes the decompressed original bytes.
Raw `.log` copies remain locally for inspection but are not staged: their exact
Vite/Vitest whitespace is preserved in the archives instead of being edited to
satisfy git diff --check. Every archive was decompressed and byte-compared before
publication. Initial failures and the pipe negative control are preserved.

After final tests, extra trailing blank lines at the end of launcher_inputs.py
were removed to satisfy the staged whitespace check. No executable line changed.
The final source manifest records that formatting-only fingerprint correction.
