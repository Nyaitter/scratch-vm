const Runtime = require('../engine/runtime');
const Base64Util = require('../util/base64-util');
const ExtendedJSON = require('@turbowarp/json');

const clone = value => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    return JSON.parse(JSON.stringify(value));
};
const equal = (left, right) => {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    if (Array.isArray(left)) {
        if (left.length !== right.length) return false;
        for (let i = 0; i < left.length; i++) if (!equal(left[i], right[i])) return false;
        return true;
    }
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key]));
};

const captureMonitors = (runtime, toCanonicalTargetId) => runtime.getMonitorState()
    .values()
    .map(monitor => {
        const result = clone(monitor);
        if (result?.targetId) result.targetId = toCanonicalTargetId(result.targetId);
        return result;
    });

const captureVariables = (runtime, toCanonicalTargetId, previous) => {
    const saved = new Map((previous || []).map(item => [JSON.stringify([item.targetId, item.id]), item]));
    return runtime.targets
        .filter(target => target.isOriginal !== false)
        .reduce((variables, target) => {
            Object.values(target.variables || {}).forEach(variable => {
                if (variable.type !== '' && variable.type !== 'list') return;
                const targetId = toCanonicalTargetId(target.id);
                const old = saved.get(JSON.stringify([targetId, variable.id]));
                if (old && equal(old.value, variable.value)) {
                    variables.push(old);
                    return;
                }
                variables.push({
                    targetId,
                    id: variable.id,
                    value: clone(variable.value)
                });
            });
            return variables;
        }, []);
};

const captureTargets = (runtime, toCanonicalTargetId) => runtime.targets
    .map(target => {
        const looksState = target.getCustomState ? target.getCustomState('Scratch.looks') : null;
        return {
            targetId: toCanonicalTargetId(target.id),
            isOriginal: target.isOriginal !== false,
            originalTargetId: target.isOriginal === false ?
                toCanonicalTargetId(target.sprite?.clones?.[0]?.id || target.id) :
                null,
            x: target.x,
            y: target.y,
            direction: target.direction,
            size: target.size,
            draggable: target.draggable,
            visible: target.visible,
            currentCostume: target.currentCostume,
            rotationStyle: target.rotationStyle,
            effects: clone(target.effects || {}),
            volume: target.volume,
            tempo: target.tempo,
            videoTransparency: target.videoTransparency,
            videoState: target.videoState,
            textToSpeechLanguage: target.textToSpeechLanguage,
            sayText: looksState?.text || null,
            sayType: looksState?.type || null,
            ...(target.soundEffects ? {soundEffects: clone(target.soundEffects)} : {})
        };
    });

const captureRuntimeState = (vm, toCanonicalTargetId = targetId => targetId,
    forceRunning = null, previous = null) => ({
    running: forceRunning === null ?
        Boolean(vm.runtime._nonMonitorThreadCount || vm.runtime.threads.some(thread => !thread.updateMonitor)) :
        Boolean(forceRunning),
    targets: captureTargets(vm.runtime, toCanonicalTargetId),
    variables: captureVariables(vm.runtime, toCanonicalTargetId, previous?.variables),
    monitors: captureMonitors(vm.runtime, toCanonicalTargetId),
    options: vm.runtime._nditorOptions,
    penSequence: vm.runtime._nditorPenSequence || 0,
    penCommands: vm.runtime._nditorPenCommands || [],
    scriptGlows: clone(vm.runtime._collaborationScriptGlows || [])
});

const createRuntimeDelta = (before, after, full = false) => {
    if (full) {
        return {
            full: true,
            options: after.options,
            pen: {sequence: after.penSequence, commands: after.penCommands},
            running: after.running,
            targets: after.targets,
            removedTargetIds: [],
            variables: after.variables,
            monitors: after.monitors,
            removedMonitorIds: [],
            scriptGlows: after.scriptGlows
        };
    }
    const previousTargets = new Map((before?.targets || [])
        .map(target => [target.targetId, target]));
    const targets = after.targets.filter(target => {
        const changed = !previousTargets.has(target.targetId) || !equal(previousTargets.get(target.targetId), target);
        previousTargets.delete(target.targetId);
        return changed;
    });
    const removedTargetIds = [...previousTargets.keys()];
    const previousVariables = new Map((before?.variables || [])
        .map(variable => [`${variable.targetId}:${variable.id}`, variable]));
    const variables = after.variables.filter(variable => {
        const key = `${variable.targetId}:${variable.id}`;
        const changed = !previousVariables.has(key) || !equal(previousVariables.get(key).value, variable.value);
        previousVariables.delete(key);
        return changed;
    });
    const previous = new Map((before?.monitors || []).map(monitor => [monitor.id, monitor]));
    const monitors = [];
    const removedMonitorIds = [];
    after.monitors.forEach(monitor => {
        if (!previous.has(monitor.id) || !equal(previous.get(monitor.id), monitor)) monitors.push(monitor);
        previous.delete(monitor.id);
    });
    previous.forEach(monitor => removedMonitorIds.push(monitor.id));
    const delta = {targets, removedTargetIds, variables, monitors, removedMonitorIds};
    if (!before || before.options !== after.options) delta.options = after.options;
    if (!before || before.penSequence !== after.penSequence) {
        const start = after.penSequence - after.penCommands.length;
        delta.pen = {sequence: after.penSequence,
            commands: after.penCommands.slice(Math.max(0, (before?.penSequence || 0) - start))};
    }
    if (!before || before.running !== after.running) delta.running = after.running;
    if (!before || !equal(before.scriptGlows, after.scriptGlows)) delta.scriptGlows = after.scriptGlows;
    return delta;
};

const runtimeDeltaHasChanges = delta => Object.prototype.hasOwnProperty.call(delta, 'running') ||
    Object.prototype.hasOwnProperty.call(delta, 'options') || Boolean(delta.pen) ||
    Object.prototype.hasOwnProperty.call(delta, 'scriptGlows') ||
    delta.targets.length > 0 || (delta.removedTargetIds && delta.removedTargetIds.length > 0) ||
    delta.variables.length > 0 || delta.monitors.length > 0 ||
    delta.removedMonitorIds.length > 0;

/**
 * Collaboration boundary owned by Scratch VM.
 *
 * Project files are transferred only when a participant joins or explicitly
 * resynchronizes. Normal edits are emitted as VM operations and applied once.
 */
class CollaborationController {
    constructor (vm, {role, onOperation, onRuntimeState = null, runtimeInterval = 50} = {}) {
        if (!vm?.runtime) throw new Error('A Scratch VM is required.');
        if (role !== 'host' && role !== 'guest') throw new Error('Collaboration role must be host or guest.');
        if (typeof onOperation !== 'function') throw new Error('onOperation must be a function.');

        this.vm = vm;
        this.role = role;
        this.onOperation = onOperation;
        this.onRuntimeState = typeof onRuntimeState === 'function' ? onRuntimeState : null;
        this.runtimeInterval = Math.max(16, Number(runtimeInterval) || 50);
        this.closed = false;
        this.paused = false;
        this.runtimeTimer = null;
        // Scratch assigns target IDs while deserializing an sb3. Those IDs are
        // VM-local, so never overwrite them after loading. Collaboration uses
        // the host IDs on the wire and translates only at this boundary.
        this.canonicalTargetIds = new Map();
        this.localTargetIds = new Map();
        this.canonicalBlockIds = new Map();
        this.localBlockIds = new Map();
        this.runtimeState = captureRuntimeState(vm, targetId => this.toCanonicalTargetId(targetId));
        this.remoteMonitorIds = new Set();
        this.applyQueue = Promise.resolve();
        this.applyingOperation = false;
        this.lastOptions = this.captureOptions();
        this.vm.runtime._nditorOptions = this.lastOptions;
        this.vm.runtime._nditorPenTracking = true;
        this.vm.runtime._nditorCollaborationRole = role;
        this.handleOptionsChange = () => {
            if (this.closed || this.paused || this.applyingOperation) return;
            const data = this.captureOptions();
            if (data === this.lastOptions) return;
            this.lastOptions = data;
            this.vm.runtime._nditorOptions = data;
            this.onOperation({kind: 'runtime.options', data});
            if (this.role === 'host') this.handleRuntimeChange(true);
        };
        ['FRAMERATE_CHANGED', 'INTERPOLATION_CHANGED', 'RUNTIME_OPTIONS_CHANGED',
            'COMPILER_OPTIONS_CHANGED', 'STAGE_SIZE_CHANGED', 'TURBO_MODE_ON', 'TURBO_MODE_OFF',
            'collaborationOptionsChanged'].forEach(event => this.vm.on(event, this.handleOptionsChange));

        this.handleThrottledRuntimeChange = () => this.handleRuntimeChange(false);
        this.handleImmediateRuntimeChange = () => this.handleRuntimeChange(true);
        this.handleProjectRunStart = () => this.handleRuntimeChange(true, true);
        this.handleProjectRunStop = () => this.handleRuntimeChange(true, false);
        this.handleOperation = this.handleOperation.bind(this);
        this.vm.on('collaborationOperation', this.handleOperation);

        if (role === 'host' && this.onRuntimeState) {
            this.vm.runtime.on(Runtime.AFTER_EXECUTE, this.handleThrottledRuntimeChange);
            this.vm.runtime.on(Runtime.MONITORS_UPDATE, this.handleThrottledRuntimeChange);
            this.vm.runtime.on(Runtime.PROJECT_RUN_START, this.handleProjectRunStart);
            this.vm.runtime.on(Runtime.PROJECT_RUN_STOP, this.handleProjectRunStop);
            this.vm.runtime.on(Runtime.PROJECT_STOP_ALL, this.handleProjectRunStop);
            this.vm.runtime.on(Runtime.COLLABORATION_GLOWS_UPDATE, this.handleThrottledRuntimeChange);
        }
    }

    setTargetIdMapping (canonicalTargetId, localTargetId) {
        const canonical = String(canonicalTargetId || '');
        const local = String(localTargetId || '');
        if (!canonical || !local) return;
        const previousLocal = this.canonicalTargetIds.get(canonical);
        if (previousLocal && previousLocal !== local) this.localTargetIds.delete(previousLocal);
        const previousCanonical = this.localTargetIds.get(local);
        if (previousCanonical && previousCanonical !== canonical) {
            this.canonicalTargetIds.delete(previousCanonical);
        }
        this.canonicalTargetIds.set(canonical, local);
        this.localTargetIds.set(local, canonical);
    }

    removeTargetIdMapping (canonicalTargetId) {
        const canonical = String(canonicalTargetId || '');
        if (!canonical) return;
        const local = this.canonicalTargetIds.get(canonical);
        this.canonicalTargetIds.delete(canonical);
        if (local) this.localTargetIds.delete(local);
    }

    toCanonicalTargetId (targetId) {
        const local = String(targetId || '');
        return this.localTargetIds.get(local) || local;
    }

    toLocalTargetId (targetId) {
        const canonical = String(targetId || '');
        return this.canonicalTargetIds.get(canonical) || canonical;
    }

    setBlockIdMapping (canonicalId, localId) {
        if (!canonicalId || !localId) return;
        this.canonicalBlockIds.set(canonicalId, localId);
        this.localBlockIds.set(localId, canonicalId);
    }

    toCanonicalBlockId (id) {
        return this.localBlockIds.get(id) || id;
    }

    toLocalBlockId (id) {
        return this.canonicalBlockIds.get(id) || id;
    }

    captureBlockLinks (target) {
        return {
            roots: [...(target.blocks?._scripts || [])],
            blocks: Object.values(target.blocks?._blocks || {}).map(block => [
                block.id,
                block.next || null,
                Object.entries(block.inputs || {}).map(([name, input]) =>
                    [name, input.block || null, input.shadow || null])
            ])
        };
    }

    mapLoadedBlocks (links, target) {
        const blocks = target.blocks;
        const sourceLinks = Array.isArray(links) ? links : links.blocks;
        const pending = new Map(sourceLinks.map(link => [link[0], link]));
        for (const id of pending.keys()) {
            if (blocks.getBlock(id)) this.setBlockIdMapping(id, id);
        }
        (links.roots || []).forEach((id, index) => {
            const localId = blocks._scripts[index];
            if (localId) this.setBlockIdMapping(id, localId);
        });
        let changed = true;
        while (changed) {
            changed = false;
            for (const [canonicalId, nextId, inputs] of pending.values()) {
                const local = blocks.getBlock(this.toLocalBlockId(canonicalId));
                if (!local) continue;
                const pairs = [[nextId, local.next]];
                for (const [name, blockId, shadowId] of inputs) {
                    pairs.push([blockId, local.inputs?.[name]?.block]);
                    pairs.push([shadowId, local.inputs?.[name]?.shadow]);
                }
                for (const [canonicalChild, localChild] of pairs) {
                    if (canonicalChild && localChild && !this.canonicalBlockIds.has(canonicalChild)) {
                        this.setBlockIdMapping(canonicalChild, localChild);
                        changed = true;
                    }
                }
                pending.delete(canonicalId);
            }
        }
    }

    mapBlockEvent (event, toId) {
        if (!event) return;
        ['blockId', 'oldParentId', 'newParentId'].forEach(key => {
            if (typeof event[key] === 'string') event[key] = toId(event[key]);
        });
        if (Array.isArray(event.ids)) event.ids = event.ids.map(toId);
    }

    captureOptions () {
        return ExtendedJSON.stringify({
            ...this.vm.runtime._generateAllProjectOptions(),
            compilerOptions: this.vm.runtime.compilerOptions
        });
    }

    normalizeOutgoingOperation (operation) {
        const normalized = clone(operation);
        if (normalized?.kind === 'block') this.mapBlockEvent(normalized.event, id => this.toCanonicalBlockId(id));
        if (!normalized?.targetId) return normalized;
        if (normalized.kind === 'sprite.add') {
            // A new sprite's locally generated ID becomes its canonical ID.
            this.setTargetIdMapping(normalized.targetId, normalized.targetId);
            const target = this.vm.runtime.getTargetById(normalized.targetId);
            if (target) normalized.blockLinks = this.captureBlockLinks(target);
            return normalized;
        }
        normalized.targetId = this.toCanonicalTargetId(normalized.targetId);
        return normalized;
    }

    normalizeIncomingOperation (operation) {
        const normalized = clone(operation);
        if (normalized?.kind === 'block') this.mapBlockEvent(normalized.event, id => this.toLocalBlockId(id));
        if (!normalized?.targetId || normalized.kind === 'sprite.add') return normalized;
        normalized.targetId = this.toLocalTargetId(normalized.targetId);
        return normalized;
    }

    handleOperation (operation) {
        if (this.closed || this.paused || !operation?.kind) return;
        const normalized = this.normalizeOutgoingOperation(operation);
        this.onOperation(normalized);
        if (normalized.kind === 'sprite.delete') this.removeTargetIdMapping(normalized.targetId);
    }

    handleRuntimeChange (immediate = false, forceRunning = null) {
        if (this.closed || this.paused || !this.onRuntimeState) return;
        if (immediate) {
            if (this.runtimeTimer) {
                clearTimeout(this.runtimeTimer);
                this.runtimeTimer = null;
            }
            const next = captureRuntimeState(this.vm, targetId => this.toCanonicalTargetId(targetId),
                forceRunning, this.runtimeState);
            const delta = createRuntimeDelta(this.runtimeState, next);
            this.runtimeState = next;
            if (runtimeDeltaHasChanges(delta)) this.onRuntimeState(this.normalizeRuntimePen(delta));
            return;
        }
        if (this.runtimeTimer) return;
        this.runtimeTimer = setTimeout(() => {
            this.runtimeTimer = null;
            const next = captureRuntimeState(this.vm, targetId => this.toCanonicalTargetId(targetId),
                null, this.runtimeState);
            const delta = createRuntimeDelta(this.runtimeState, next);
            this.runtimeState = next;
            if (runtimeDeltaHasChanges(delta)) this.onRuntimeState(this.normalizeRuntimePen(delta));
        }, this.runtimeInterval);
    }

    setPaused (paused) {
        this.paused = Boolean(paused);
        if (!this.paused) {
            this.runtimeState = captureRuntimeState(this.vm, targetId => this.toCanonicalTargetId(targetId));
            this.lastOptions = this.captureOptions();
            this.vm.runtime._nditorOptions = this.lastOptions;
        }
    }

    async captureProject () {
        if (this.closed) throw new Error('The collaboration controller is closed.');
        const data = await this.vm.saveProjectSb3('arraybuffer');
        return {
            format: 'sb3-base64',
            data: Base64Util.arrayBufferToBase64(data),
            targets: this.vm.runtime.targets
                .filter(target => target.isOriginal !== false)
                .map(target => ({id: target.id,
                    isStage: target.isStage,
                    name: target.getName(),
                    blockLinks: this.captureBlockLinks(target)})),
            editingTargetId: this.vm.editingTarget?.id || null,
            options: this.captureOptions(),
            question: this.vm.runtime._collaborationQuestion ?? null,
            questionInput: this.vm.runtime._collaborationQuestionInput || ''
        };
    }

    loadProject (snapshot) {
        const apply = async () => {
            if (this.closed) throw new Error('The collaboration controller is closed.');
            if (snapshot?.format !== 'sb3-base64' || typeof snapshot.data !== 'string') {
                throw new Error('Unsupported collaboration project snapshot.');
            }
            await this.vm.loadProject(Base64Util.base64ToUint8Array(snapshot.data));
            if (typeof snapshot.options === 'string') {
                this.applyingOperation = true;
                try {
                    await this.vm.applyCollaborationOperation({kind: 'runtime.options', data: snapshot.options});
                } finally {
                    this.applyingOperation = false;
                }
            }
            const loadedTargets = this.vm.runtime.targets.filter(target => target.isOriginal !== false);
            this.canonicalTargetIds.clear();
            this.localTargetIds.clear();
            this.canonicalBlockIds.clear();
            this.localBlockIds.clear();
            loadedTargets.forEach((target, index) => {
                const expected = snapshot.targets?.[index];
                if (!expected?.id || Boolean(expected.isStage) !== Boolean(target.isStage)) return;
                this.setTargetIdMapping(expected.id, target.id);
                if (expected.blockLinks) this.mapLoadedBlocks(expected.blockLinks, target);
            });
            const editingTargetId = this.toLocalTargetId(snapshot.editingTargetId);
            if (editingTargetId && this.vm.runtime.getTargetById(editingTargetId)) {
                this.vm.setEditingTarget(editingTargetId);
            }
            this.vm.runtime._collaborationQuestion = snapshot.question ?? null;
            this.vm.runtime.emit('QUESTION', this.vm.runtime._collaborationQuestion);
            this.vm.runtime.emit('QUESTION_INPUT', snapshot.questionInput || '', {remote: true});
            this.runtimeState = captureRuntimeState(this.vm, targetId => this.toCanonicalTargetId(targetId));
            this.lastOptions = this.captureOptions();
            this.vm.runtime._nditorOptions = this.lastOptions;
        };
        this.applyQueue = this.applyQueue.catch(() => {}).then(apply);
        return this.applyQueue;
    }

    applyOperation (operation) {
        const apply = async () => {
            if (this.closed) throw new Error('The collaboration controller is closed.');
            const canonicalOperation = clone(operation);
            const localOperation = this.normalizeIncomingOperation(canonicalOperation);
            this.applyingOperation = true;
            let applied;
            try {
                applied = await this.vm.applyCollaborationOperation(localOperation);
            } finally {
                this.applyingOperation = false;
                this.lastOptions = this.captureOptions();
                this.vm.runtime._nditorOptions = this.lastOptions;
            }
            if (canonicalOperation.kind === 'sprite.add' && canonicalOperation.targetId) {
                const target = this.vm.runtime.getTargetById(localOperation.targetId);
                if (target) {
                    this.setTargetIdMapping(canonicalOperation.targetId, target.id);
                    if (canonicalOperation.blockLinks) this.mapLoadedBlocks(canonicalOperation.blockLinks, target);
                }
            } else if (canonicalOperation.kind === 'sprite.delete') {
                this.removeTargetIdMapping(canonicalOperation.targetId);
            }
            if (canonicalOperation.kind === 'runtime.options' || canonicalOperation.kind === 'project.options') {
                return {...canonicalOperation, data: this.captureOptions()};
            }
            return canonicalOperation.kind === 'costume.update' && applied ?
                {...canonicalOperation, costume: applied, canonicalCostume: true} : canonicalOperation;
        };
        this.applyQueue = this.applyQueue.catch(() => {}).then(apply);
        return this.applyQueue;
    }

    captureRuntime () {
        const state = captureRuntimeState(this.vm, targetId => this.toCanonicalTargetId(targetId));
        this.runtimeState = state;
        return this.normalizeRuntimePen(createRuntimeDelta(null, state, true));
    }

    normalizeRuntimePen (delta) {
        if (!delta.pen) return delta;
        return {...delta,
            pen: {...delta.pen,
                commands: delta.pen.commands.map(command => ({...command,
                    ...(command.targetId ? {targetId: this.toCanonicalTargetId(command.targetId),
                        originalTargetId: this.toCanonicalTargetId(command.originalTargetId)} : {})}))}};
    }

    applyRuntime (state) {
        if (this.closed || this.role !== 'guest' || !state) return;

        if (typeof state.options === 'string' && state.options !== this.lastOptions) {
            this.applyingOperation = true;
            try {
                // The options branch applies synchronously, before the promise resolves.
                void this.vm.applyCollaborationOperation({kind: 'runtime.options', data: state.options});
                this.lastOptions = this.captureOptions();
                this.vm.runtime._nditorOptions = this.lastOptions;
            } finally {
                this.applyingOperation = false;
            }
        }

        if (Object.prototype.hasOwnProperty.call(state, 'running')) {
            const isRunning = Boolean(state.running);
            if (this.lastRemoteRunning !== isRunning) {
                this.lastRemoteRunning = isRunning;
                if (isRunning) {
                    if (!this.vm.runtime.frameLoop?.running) {
                        this.vm.runtime.start();
                    }
                    this.vm.runtime.emit('PROJECT_START');
                    this.vm.runtime.emit(Runtime.PROJECT_RUN_START);
                } else {
                    this.vm.runtime.emit(Runtime.PROJECT_RUN_STOP);
                }
            }
        }

        let targetsChanged = false;
        const removedTargets = Array.isArray(state.removedTargetIds) ? state.removedTargetIds : [];
        removedTargets.forEach(remoteId => {
            const localId = this.toLocalTargetId(remoteId);
            const target = this.vm.runtime.getTargetById(localId);
            if (target && target.isOriginal === false) {
                if (typeof this.vm.runtime.disposeTarget === 'function') {
                    this.vm.runtime.disposeTarget(target);
                } else {
                    target.dispose();
                }
                this.remoteCloneIds?.delete(remoteId);
                this.removeTargetIdMapping(remoteId);
                targetsChanged = true;
            }
        });

        const targets = Array.isArray(state.targets) ? state.targets : [];
        targets.forEach(remoteTarget => {
            let target = this.vm.runtime.getTargetById(this.toLocalTargetId(remoteTarget?.targetId));
            if (!target && remoteTarget.isOriginal === false && remoteTarget.originalTargetId) {
                const original = this.vm.runtime.getTargetById(this.toLocalTargetId(remoteTarget.originalTargetId));
                if (original && typeof original.makeClone === 'function') {
                    target = original.makeClone();
                    if (target) {
                        this.vm.runtime.addTarget(target);
                        if (typeof target.goBehindOther === 'function') {
                            target.goBehindOther(original);
                        }
                        this.setTargetIdMapping(remoteTarget.targetId, target.id);
                        if (!this.remoteCloneIds) this.remoteCloneIds = new Set();
                        this.remoteCloneIds.add(remoteTarget.targetId);
                    }
                }
            }
            if (!target) return;

            const previous = {
                x: target.x,
                y: target.y,
                direction: target.direction,
                size: target.size,
                visible: target.visible,
                currentCostume: target.currentCostume,
                rotationStyle: target.rotationStyle,
                effects: clone(target.effects || {}),
                draggable: target.draggable,
                volume: target.volume,
                tempo: target.tempo,
                videoTransparency: target.videoTransparency,
                videoState: target.videoState,
                textToSpeechLanguage: target.textToSpeechLanguage
            };
            ['x', 'y', 'direction', 'size', 'volume', 'tempo', 'videoTransparency'].forEach(key => {
                const value = Number(remoteTarget[key]);
                if (Number.isFinite(value)) target[key] = value;
            });
            if (Object.prototype.hasOwnProperty.call(remoteTarget, 'draggable')) {
                target.draggable = Boolean(remoteTarget.draggable);
            }
            if (Object.prototype.hasOwnProperty.call(remoteTarget, 'visible')) {
                target.visible = Boolean(remoteTarget.visible);
            }
            const costume = Number(remoteTarget.currentCostume);
            if (Number.isFinite(costume) && target.sprite?.costumes?.length) {
                target.currentCostume = Math.max(0, Math.min(target.sprite.costumes.length - 1, Math.round(costume)));
            }
            if (typeof remoteTarget.rotationStyle === 'string') target.rotationStyle = remoteTarget.rotationStyle;
            if (typeof remoteTarget.videoState === 'string') target.videoState = remoteTarget.videoState;
            if (Object.prototype.hasOwnProperty.call(remoteTarget, 'textToSpeechLanguage')) {
                target.textToSpeechLanguage = remoteTarget.textToSpeechLanguage;
            }
            if (remoteTarget.effects && typeof remoteTarget.effects === 'object') {
                Object.keys(target.effects || {}).forEach(effect => {
                    const value = Number(remoteTarget.effects[effect]);
                    if (Number.isFinite(value)) target.effects[effect] = value;
                });
            }
            if (remoteTarget.soundEffects && typeof remoteTarget.soundEffects === 'object') {
                target.soundEffects = clone(remoteTarget.soundEffects);
                target.sprite?.soundBank?.setEffects?.(target);
            }
            if (typeof remoteTarget.sayText !== 'undefined') {
                const looksState = target.getCustomState ? target.getCustomState('Scratch.looks') : null;
                const newText = remoteTarget.sayText || '';
                const newType = remoteTarget.sayType || 'say';
                if ((looksState?.text || '') !== newText || (looksState?.type || 'say') !== newType) {
                    this.vm.runtime.emit('SAY', target, newType, newText);
                }
            }

            const visualChanged = previous.x !== target.x || previous.y !== target.y ||
                previous.direction !== target.direction || previous.size !== target.size ||
                previous.visible !== target.visible || previous.currentCostume !== target.currentCostume ||
                previous.rotationStyle !== target.rotationStyle || !equal(previous.effects, target.effects);
            if (visualChanged && target.renderer && target.drawableID !== null) {
                target.renderer.updateDrawablePosition(target.drawableID, [target.x, target.y]);
                const rendered = target._getRenderedDirectionAndScale();
                target.renderer.updateDrawableDirectionScale(target.drawableID, rendered.direction, rendered.scale);
                target.renderer.updateDrawableVisible(target.drawableID, target.visible);
                const currentCostume = target.sprite?.costumes?.[target.currentCostume];
                if (currentCostume) target.renderer.updateDrawableSkinId(target.drawableID, currentCostume.skinId);
                Object.keys(target.effects || {}).forEach(effect => {
                    target.renderer.updateDrawableEffect(target.drawableID, effect, target.effects[effect]);
                });
                if (target.interpolationData) {
                    target.interpolationData.x = target.x;
                    target.interpolationData.y = target.y;
                    target.interpolationData.direction = rendered.direction;
                    target.interpolationData.scale = rendered.scale;
                    target.interpolationData.costume = target.currentCostume;
                    target.interpolationData.ghost = target.effects.ghost;
                }
                this.vm.runtime.requestRedraw();
            }
            if (visualChanged || previous.draggable !== target.draggable || previous.volume !== target.volume ||
                previous.tempo !== target.tempo || previous.videoTransparency !== target.videoTransparency ||
                previous.videoState !== target.videoState ||
                previous.textToSpeechLanguage !== target.textToSpeechLanguage) {
                targetsChanged = true;
            }
        });
        if (targetsChanged) {
            this.vm.emitTargetsUpdate(false);
            const renderer = this.vm.runtime?.renderer || this.vm.renderer;
            if (renderer) {
                renderer.dirty = true;
                renderer.draw();
            }
        }

        const variables = Array.isArray(state.variables) ? state.variables : [];
        variables.forEach(remoteVariable => {
            const target = this.vm.runtime.getTargetById(this.toLocalTargetId(remoteVariable?.targetId));
            const variable = target?.lookupVariableById(remoteVariable?.id);
            if (!variable || equal(variable.value, remoteVariable.value)) return;
            variable.value = clone(remoteVariable.value);
            if (Array.isArray(variable.value)) variable._monitorUpToDate = false;
        });
        const monitors = Array.isArray(state.monitors) ? state.monitors : [];
        const localMonitors = monitors.map(monitor => {
            if (!monitor?.targetId) return monitor;
            return {...monitor, targetId: this.toLocalTargetId(monitor.targetId)};
        });
        const removed = Array.isArray(state.removedMonitorIds) ? state.removedMonitorIds : [];
        if (state.full) this.remoteMonitorIds = new Set(localMonitors.map(monitor => monitor?.id).filter(Boolean));
        removed.forEach(id => this.remoteMonitorIds.delete(id));
        localMonitors.forEach(monitor => {
            if (monitor?.id) this.remoteMonitorIds.add(monitor.id);
        });
        this.vm.runtime.applyCollaborationMonitorState(localMonitors, removed, Boolean(state.full));

        if (state.pen && (state.full || state.pen.sequence > (this.vm.runtime._nditorPenSequence || 0))) {
            const commands = (state.pen.commands || []).map(command => ({...command,
                ...(command.targetId ? {targetId: this.toLocalTargetId(command.targetId),
                    originalTargetId: this.toLocalTargetId(command.originalTargetId)} : {})}));
            const history = state.full ? [] : (this.vm.runtime._nditorPenCommands || []);
            for (const command of commands) {
                if (command.type === 'clear') history.length = 0;
                history.push(command);
            }
            this.vm.runtime._nditorPenCommands = history;
            this.vm.runtime._nditorPenSequence = state.pen.sequence;
            const pen = this.vm.runtime.ext_pen;
            if (pen) {
                pen.replayDrawing(state.full ? [{type: 'clear'}, ...commands] : commands,
                    id => this.vm.runtime.getTargetById(id));
            }
        }

        if (Object.prototype.hasOwnProperty.call(state, 'scriptGlows')) {
            const previous = new Set(this.vm.runtime._nyaitterRemoteScriptGlows || []);
            const next = new Set((state.scriptGlows || []).map(id => this.toLocalBlockId(String(id))));
            const visible = id => Boolean(this.vm.editingTarget?.blocks?.getBlock(id));
            previous.forEach(id => {
                if (!next.has(id) && visible(id)) this.vm.runtime.glowScript(id, false);
            });
            next.forEach(id => {
                if (!previous.has(id) && visible(id)) this.vm.runtime.glowScript(id, true);
            });
            this.vm.runtime._nyaitterRemoteScriptGlows = [...next];
        }
    }

    close () {
        if (this.closed) return;
        this.closed = true;
        this.vm.runtime._nditorPenTracking = false;
        this.vm.runtime._nditorCollaborationRole = null;
        clearTimeout(this.runtimeTimer);
        this.vm.off('collaborationOperation', this.handleOperation);
        ['FRAMERATE_CHANGED', 'INTERPOLATION_CHANGED', 'RUNTIME_OPTIONS_CHANGED',
            'COMPILER_OPTIONS_CHANGED', 'STAGE_SIZE_CHANGED', 'TURBO_MODE_ON', 'TURBO_MODE_OFF',
            'collaborationOptionsChanged'].forEach(event => this.vm.off(event, this.handleOptionsChange));
        this.vm.runtime.off(Runtime.AFTER_EXECUTE, this.handleThrottledRuntimeChange);
        this.vm.runtime.off(Runtime.MONITORS_UPDATE, this.handleThrottledRuntimeChange);
        this.vm.runtime.off(Runtime.PROJECT_RUN_START, this.handleProjectRunStart);
        this.vm.runtime.off(Runtime.PROJECT_RUN_STOP, this.handleProjectRunStop);
        this.vm.runtime.off(Runtime.PROJECT_STOP_ALL, this.handleProjectRunStop);
        this.vm.runtime.off(Runtime.COLLABORATION_GLOWS_UPDATE, this.handleThrottledRuntimeChange);
        if (this.role === 'guest') {
            if (this.remoteMonitorIds.size > 0) {
                this.vm.runtime.applyCollaborationMonitorState([], [...this.remoteMonitorIds], false);
            }
            if (this.remoteCloneIds?.size > 0) {
                for (const cloneId of this.remoteCloneIds) {
                    const target = this.vm.runtime.getTargetById(this.toLocalTargetId(cloneId));
                    if (target && target.isOriginal === false) {
                        if (typeof this.vm.runtime.disposeTarget === 'function') {
                            this.vm.runtime.disposeTarget(target);
                        } else {
                            target.dispose();
                        }
                    }
                }
                this.remoteCloneIds.clear();
            }
        }
        delete this.vm.runtime._nyaitterRemoteScriptGlows;
    }
}

module.exports = CollaborationController;
