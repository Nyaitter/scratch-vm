# Nyaitter Scratch VM fork

This fork contains Nditor's compiler with live editing, collaboration operation
and runtime synchronization, concurrent costume merging, Pen drawing replay,
host extension value routing and runtime memory/CPU improvements.

Upstream: https://github.com/TurboWarp/scratch-vm
Nyaitter fork: https://github.com/Nyaitter/scratch-vm

The collaboration integration is in `src/nyaitter`. Cloud extension sandboxing
is supplied by Nditor's server via the extension loader hook; that server is not
part of this VM package. The upstream licenses and project history are preserved.
