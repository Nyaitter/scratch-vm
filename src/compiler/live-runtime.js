const {compile, address} = require('./live');

const CHECKPOINT = Symbol('live compiler checkpoint');
const RELOAD = Symbol('live compiler reload');
const createFrame = (pc, code = '', params = Object.create(null), warp = false) => ({
    pc, code, params, warp, returnValue: '', locals: Object.create(null), scopes: []
});

class LiveExecution {
    constructor (thread, initialFrame = null) {
        this.thread = thread;
        this.state = {
            frames: [initialFrame || createFrame(address(thread.topBlock))],
            generation: -1,
            pending: 0,
            returnValue: '',
            disposed: false,
            program: null
        };
        this.generator = null;
        this.programKey = JSON.stringify([thread.topBlock, thread.stackClick]);
        this.atCheckpoint = true;
        this.children = new Set();
        thread.liveCheckpoint = CHECKPOINT;
        thread.liveReload = RELOAD;
        const block = thread.blockContainer.getBlock(thread.topBlock);
        const runtime = thread.target.runtime;
        if (block && runtime._hats[block.opcode] && !thread.stackClick && runtime.getOpcodeFunction(block.opcode)) {
            thread.executableHat = true;
        }
    }
    getProgram () {
        const thread = this.thread;
        const blocks = thread.blockContainer;
        const programs = blocks._cache.livePrograms || (blocks._cache.livePrograms = new Map());
        const key = this.programKey;
        let program = programs.get(key);
        const roots = [];
        for (const frame of this.state.frames) {
            if (!frame.pc || (program && program.labels.has(frame.pc))) continue;
            const [id] = JSON.parse(frame.pc);
            if (thread.blockContainer.getBlock(id)) {
                const scope = frame.scopes[frame.scopes.length - 1];
                roots.push({id, finish: scope ? address(scope.id, 'branchEnd') : null});
            }
        }
        if (!program || roots.some(root => !program.blocks.has(root.id))) {
            program = compile(thread, roots);
            programs.set(key, program);
        }
        return program;
    }
    prepare () {
        const program = this.getProgram();
        this.state.program = program;
        this.state.generation = this.thread.blockContainer.editGeneration;
        // Retain execution position, arguments, counters and timers; replace code.
        this.generator = program.factory(this.thread)(this.state);
        this.atCheckpoint = false;
    }
    next () {
        if (this.state.disposed) return {done: true, value: this.state.returnValue};
        try {
            if (!this.generator || (this.atCheckpoint && !this.state.pending &&
                this.state.generation !== this.thread.blockContainer.editGeneration)) this.prepare();
            let result = this.generator.next();
            while (result.done && result.value === RELOAD && !this.state.disposed) {
                this.prepare();
                result = this.generator.next();
            }
            this.atCheckpoint = result.value === CHECKPOINT;
            if (result.done) this.state.returnValue = result.value;
            if (result.done && this.thread.liveExecution === this) {
                this.thread.target.runtime.sequencer.retireThread(this.thread);
            }
            return result;
        } catch (error) {
            this.thread.target.runtime.emitCompileError(this.thread.target, error);
            this.thread.target.runtime.sequencer.retireThread(this.thread);
            return {done: true, value: ''};
        }
    }
    makeCall (state, code, args, caller) {
        const procedure = state.program.procedures[code];
        if (!procedure) return null;
        const params = Object.create(null);
        for (let i = 0; i < procedure.names.length; i++) {
            params[procedure.names[i]] = i < args.length ? args[i] : procedure.defaults[i];
        }
        return createFrame(procedure.entry, code, params, caller.warp || procedure.warp);
    }
    *pendingInput (state, generator) {
        state.pending++;
        try {
            return yield* generator;
        } finally {
            state.pending--;
        }
    }
    *callReporter (state, code, args, warp, callerCode) {
        if (state.generation !== this.thread.blockContainer.editGeneration) state.program = this.getProgram();
        const frame = this.makeCall(state, code, args, {warp});
        if (!frame) return '';
        if (!warp && code === callerCode) yield CHECKPOINT;
        const child = new LiveExecution(this.thread, frame);
        this.children.add(child);
        try {
            let result = child.next();
            while (!result.done && !state.disposed) {
                yield result.value;
                result = child.next();
            }
            return result.value;
        } finally {
            child.dispose();
            this.children.delete(child);
        }
    }
    repairFrame (state, frame) {
        const [id] = JSON.parse(frame.pc);
        if (!this.thread.blockContainer.getBlock(id)) {
            // Scratch ends the active script when its executing block is deleted.
            state.frames.length = 1;
            frame.pc = null;
            return;
        }
        const scope = frame.scopes.pop();
        if (scope) {
            delete frame.locals[scope.id];
            frame.pc = scope.after;
        } else frame.pc = null;
    }
    dispose () {
        this.state.disposed = true;
        this.state.frames.length = 0;
        this.state.program = null;
        this.generator = null;
        for (const child of this.children) child.dispose();
        this.children.clear();
    }
}

module.exports = {LiveExecution};
