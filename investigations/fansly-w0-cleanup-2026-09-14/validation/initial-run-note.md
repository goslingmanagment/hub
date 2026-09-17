The first fullcheck inherited umask 077 from the private log wrapper. An
existing public-file permission fixture requested 0644 but was created as 0600,
causing one expected-rejection failure. Source was unchanged.

The wrapper now sets child umask 022, matching the ordinary shell/CI. Private
logs remain 0600. The first failed log and execution receipt are retained.
