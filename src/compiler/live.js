const {ScriptTreeGenerator} = require('./irgen');
const JSGenerator = require('./jsgen');
const {IntermediateInput, IntermediateRepresentation} = require('./intermediate');
const {InputOpcode, InputType, StackOpcode} = require('./enums');
const execute = require('./jsexecute');
const BlockType = require('../extension-support/block-type');

// Stable addresses survive edits without collisions with synthetic checkpoints.
const address = (id, phase = 'block') => (id ? JSON.stringify([id, phase]) : null);
const quote = value => JSON.stringify(value);

class LiveIRGenerator extends ScriptTreeGenerator {
    descendInputOfBlock (block, name, preserveStrings = false) {
        if (this.inputBlock === block && this.inputTemps && this.inputTemps.has(name)) {
            return this.inputTemps.get(name);
        }
        return super.descendInputOfBlock(block, name, preserveStrings);
    }
    descendInput (block, preserveStrings = false) {
        if (block.opcode === 'argument_reporter_string_number' || block.opcode === 'argument_reporter_boolean') {
            return new IntermediateInput(InputOpcode.PROCEDURE_ARGUMENT, InputType.ANY, {
                name: block.fields.VALUE.value, boolean: block.opcode === 'argument_reporter_boolean'
            });
        }
        const input = super.descendInput(block, preserveStrings);
        if (input.opcode === InputOpcode.CONSTANT && typeof input.inputs.value === 'number') {
            const field = block.fields && (block.fields.NUM || block.fields.TEXT);
            if (field && typeof field.value === 'string') {
                return new IntermediateInput(InputOpcode.CONSTANT, InputType.STRING_NUM, {value: field.value});
            }
        }
        return input;
    }
}

class LiveJSGenerator extends JSGenerator {
    generateCompatibilityLayerCall (node, setFlags, frameName = null) {
        const warp = this.isWarp;
        this.isWarp = 'frame.warp';
        try {
            return super.generateCompatibilityLayerCall(node, setFlags, frameName);
        } finally {
            this.isWarp = warp;
        }
    }
    descendAddonCall (node) {
        const warp = this.isWarp;
        this.isWarp = 'frame.warp';
        try {
            return super.descendAddonCall(node);
        } finally {
            this.isWarp = warp;
        }
    }
    descendInput (block) {
        if (block.opcode === 'live.input') return block.inputs.expression;
        if (block.opcode === InputOpcode.PROCEDURE_ARGUMENT && typeof block.inputs.name === 'string') {
            const name = block.inputs.name;
            let fallback = '0';
            if (block.inputs.boolean && ['is compiled?', 'is turbowarp?'].includes(name.toLowerCase())) {
                fallback = 'true';
            } else if (!block.inputs.boolean && name.toLowerCase() === 'last key pressed') {
                fallback = 'runtime.ioDevices.keyboard.getLastKeyPressed()';
            }
            return `(frame.params[${quote(name)}] ?? ${fallback})`;
        }
        if (block.opcode === InputOpcode.PROCEDURE_CALL) {
            const args = block.inputs.arguments.map(input => this.descendInput(input)).join(',');
            return `(yield* thread.liveExecution.pendingInput(state,
                thread.liveExecution.callReporter(state, ${quote(block.inputs.code)}, [${args}],
                    frame.warp, frame.code)))`;
        }
        if (block.opcode === InputOpcode.COMPATIBILITY_LAYER || block.opcode === InputOpcode.ADDON_CALL) {
            const expression = super.descendInput(block);
            return `(yield* thread.liveExecution.pendingInput(state,
                (function*(){ return ${expression}; })()))`;
        }
        return super.descendInput(block);
    }
}

// Compile the reachable graph into one JS generator. Control-flow instructions
// are generated JS; neither engine/execute nor interpreter frames are used.
const compile = (thread, resumableRoots = []) => {
    const blocks = thread.blockContainer;
    blocks.populateProcedureCache();
    const irgen = new LiveIRGenerator(thread);
    irgen.script.yields = true;
    irgen.script.topBlockId = thread.topBlock;
    const top = blocks.getBlock(thread.topBlock);
    if (top && top.comment) irgen.readTopBlockComment(top.comment);
    const js = new LiveJSGenerator(irgen.script, new IntermediateRepresentation(irgen.script, {}), thread.target);
    js.pushFrame(new JSGenerator.unstable_exports.Frame(false));
    const records = new Map();
    const labels = new Set();
    const procedures = Object.create(null);
    const addLabel = (id, phase = 'block') => {
        const label = address(id, phase);
        labels.add(label);
        return `case ${quote(label)}: {\n`;
    };
    const jump = pc => `frame.pc = ${quote(pc)}; continue;\n`;
    const checkpoint = 'yield thread.liveCheckpoint;\n';
    const yieldLoop = `if (!frame.warp || isStuck()) { ${checkpoint} }\n`;
    const scope = (id, kind, after) => `frame.scopes.push({id:${quote(id)},kind:${quote(kind)},
        after:${quote(after)}});\n`;
    const popScope = id => `if (frame.scopes.length &&
        frame.scopes[frame.scopes.length - 1].id === ${quote(id)}) frame.scopes.pop();\n`;
    const input = (block, name, type = null) => {
        let node = irgen.descendInputOfBlock(block, name);
        if (type !== null) node = node.toType(type);
        return js.descendInput(node);
    };
    const ordinary = block => {
        js.source = '';
        js.descendStackedBlock(irgen.descendStackedBlock(block));
        if (/\byield\b/.test(js.source)) {
            // Scratch evaluates command inputs before the command reads/mutates
            // runtime state. A reporter procedure can change that state while waiting.
            const temps = new Map();
            let prelude = '';
            for (const name of Object.keys(block.inputs)) {
                if (name.startsWith('SUBSTACK')) continue;
                const expression = input(block, name);
                const temporary = js.localVariables.next();
                prelude += `const ${temporary} = ${expression};\n`;
                temps.set(name, new IntermediateInput('live.input', InputType.ANY, {expression: temporary}));
            }
            irgen.inputBlock = block;
            irgen.inputTemps = temps;
            try {
                js.source = '';
                js.descendStackedBlock(irgen.descendStackedBlock(block));
                return prelude + js.source;
            } finally {
                irgen.inputBlock = null;
                irgen.inputTemps = null;
            }
        }
        return js.source;
    };
    const walk = (start, finish) => {
        let id = start;
        while (id && !records.has(id)) {
            const block = blocks.getBlock(id);
            if (!block) break;
            records.set(id, {block, next: block.next ? address(block.next) : finish});
            for (const name of Object.keys(block.inputs)) {
                if (name.startsWith('SUBSTACK')) walk(block.inputs[name].block, address(id, 'branchEnd'));
            }
            id = block.next;
        }
    };
    walk(thread.topBlock, null);
    for (const root of resumableRoots) walk(root.id, root.finish);
    for (const id of Object.keys(blocks._blocks)) {
        const definition = blocks.getBlock(id);
        if (definition.opcode !== 'procedures_definition') continue;
        const prototype = blocks.getBlock(definition.inputs.custom_block && definition.inputs.custom_block.block);
        if (!prototype || !prototype.mutation) continue;
        const mutation = prototype.mutation;
        const parameters = blocks.getProcedureParamNamesIdsAndDefaults(mutation.proccode);
        if (!parameters) continue;
        procedures[mutation.proccode] = {
            entry: address(definition.next),
            names: parameters[0],
            defaults: parameters[2],
            warp: mutation.warp === true || mutation.warp === 'true'
        };
        walk(definition.next, null);
    }
    const ids = [...records.keys()];
    let source = 'let frame = state.frames[state.frames.length - 1];\n';
    source += 'while (frame && !state.disposed) { switch (frame.pc) {\n';
    source += `case null: {
        if (state.frames.length === 1) return frame.returnValue;
        state.frames.pop(); frame = state.frames[state.frames.length - 1]; continue;
    }\n`;
    let recordIndex = 0;
    for (const [id, record] of records) {
        const {block, next} = record;
        const idJS = quote(id);
        const nextJS = quote(next);
        let extensionBranch = false;
        const branch = index => {
            const name = index === 1 ? 'SUBSTACK' : `SUBSTACK${index}`;
            const sub = block.inputs[name];
            return address(sub && sub.block) || address(id, 'branchEnd');
        };
        source += addLabel(id);
        switch (block.opcode) {
        case 'control_repeat':
            source += `frame.locals[${idJS}] = {remaining: Math.round(${input(block, 'TIMES', InputType.NUMBER)})};\n`;
            source += scope(id, 'loop', next);
            source += jump(address(id, 'test'));
            source += '}\n';
            source += addLabel(id, 'test');
            source += `if (frame.locals[${idJS}].remaining-- > 0) { ${jump(branch(1))} }\n`;
            source += `delete frame.locals[${idJS}];\n${popScope(id)}${jump(next)}`;
            break;
        case 'control_forever':
        case 'control_repeat_until':
        case 'control_while':
        case 'control_for_each': {
            source += `frame.locals[${idJS}] = {index:0};\n${scope(id, 'loop', next)}`;
            source += jump(address(id, 'test'));
            source += '}\n';
            source += addLabel(id, 'test');
            let condition = 'true';
            if (block.opcode === 'control_repeat_until') {
                condition = `!(${input(block, 'CONDITION', InputType.BOOLEAN)})`;
            } else if (block.opcode === 'control_while') {
                condition = input(block, 'CONDITION', InputType.BOOLEAN);
            } else if (block.opcode === 'control_for_each') {
                condition = `frame.locals[${idJS}].index < ${input(block, 'VALUE', InputType.NUMBER_OR_NAN)}`;
            }
            source += `if (${condition}) {\n`;
            if (block.opcode === 'control_for_each') {
                const variable = irgen.descendVariable(block, 'VARIABLE', '');
                source += `${js.referenceVariable(variable)}.value = ++frame.locals[${idJS}].index;\n`;
            }
            source += `${jump(branch(1))}}\n`;
            source += `delete frame.locals[${idJS}];\n${popScope(id)}${jump(next)}`;
            break;
        }
        case 'control_if':
        case 'control_if_else':
        case 'control_all_at_once': {
            source += scope(id, 'branch', next);
            const condition = block.opcode === 'control_all_at_once' ? 'true' :
                input(block, 'CONDITION', InputType.BOOLEAN);
            const whenFalse = block.opcode === 'control_if_else' ? branch(2) : address(id, 'branchEnd');
            source += `frame.pc = (${condition}) ? ${quote(branch(1))} : ${quote(whenFalse)}; continue;\n`;
            break;
        }
        case 'control_wait':
            source += `const duration = Math.max(0, 1000 * ${input(block, 'DURATION', InputType.NUMBER)});
                const timer = new globalState.Timer({now: () => runtime.currentMSecs}); timer.start();
                frame.locals[${idJS}] = {timer, duration};
                runtime.requestRedraw(); frame.pc = ${quote(address(id, 'wait'))};\n`;
            source += yieldLoop;
            source += 'continue;\n}\n';
            source += addLabel(id, 'wait');
            source += `if (frame.locals[${idJS}].timer.timeElapsed() < frame.locals[${idJS}].duration) {
                ${yieldLoop} continue;
            }
            delete frame.locals[${idJS}];\n${jump(next)}`;
            break;
        case 'control_wait_until':
            source += `if (!(${input(block, 'CONDITION', InputType.BOOLEAN)})) {
                ${yieldLoop} continue;
            }\n${jump(next)}`;
            break;
        case 'procedures_definition':
            source += jump(next);
            break;
        case 'procedures_call': {
            const procedure = irgen.getProcedureInfo(block);
            if (procedure.opcode === StackOpcode.PROCEDURE_CALL) {
                const args = procedure.inputs.arguments.map(node => js.descendInput(node)).join(',');
                source += `const args = [${args}]; frame.pc = ${nextJS};
                    const call = thread.liveExecution.makeCall(state, ${quote(procedure.inputs.code)}, args, frame);
                    if (call) {
                        const recursive = state.frames.some(f => f.code === call.code);
                        state.frames.push(call); frame = call;
                        if ((!frame.warp && recursive) || (frame.warp && isStuck())) { ${checkpoint} }
                    }
                    continue;\n`;
            } else {
                source += ordinary(block);
                source += jump(next);
            }
            break;
        }
        case 'procedures_return':
            source += `frame.returnValue = ${input(block, 'VALUE')};\n${jump(null)}`;
            break;
        case 'control_stop': {
            const option = block.fields.STOP_OPTION.value;
            if (option === 'all') source += 'runtime.stopAll(); return;\n';
            else if (option === 'other scripts in sprite' || option === 'other scripts in stage') {
                source += `runtime.stopForTarget(target, thread);\n${jump(next)}`;
            } else source += jump(null);
            break;
        }
        default: {
            const hat = thread.target.runtime._hats[block.opcode];
            if (hat) {
                const primitive = thread.target.runtime.getOpcodeFunction(block.opcode);
                if (primitive) {
                    const condition = js.descendInput(irgen.descendCompatLayerInput(block));
                    source += `const active = Boolean(${condition});\n`;
                    if (!thread.stackClick) {
                        if (hat.edgeActivated) {
                            source += `const old = target.hasEdgeActivatedValue(${idJS}) ?
                                target._edgeActivatedHatValues[${idJS}] : false;
                                target.updateEdgeActivatedValue(${idJS}, active);
                                if (old || !active) return;\n`;
                        } else source += 'if (!active) return;\n';
                        source += `frame.pc = ${nextJS};\n${checkpoint}continue;\n`;
                        break;
                    }
                }
                source += jump(next);
            } else {
                const node = irgen.descendStackedBlock(block);
                if (node.opcode === StackOpcode.COMPATIBILITY_LAYER &&
                    (node.inputs.blockType === BlockType.LOOP || node.inputs.blockType === BlockType.CONDITIONAL)) {
                    extensionBranch = true;
                    source += `frame.locals[${idJS}] = {
                        info: createBranchInfo(${node.inputs.blockType === BlockType.LOOP})};\n`;
                    source += scope(id, 'extension', next);
                    source += jump(address(id, 'test'));
                    source += '}\n';
                    source += addLabel(id, 'test');
                    const call = js.generateCompatibilityLayerCall(node.inputs, false, `frame.locals[${idJS}].info`);
                    source += `state.pending++; try {
                        frame.locals[${idJS}].branch = +(${call});
                    } finally { state.pending--; }
                    frame.pc = ${quote(address(id, 'dispatch'))};
                    if (state.generation !== thread.blockContainer.editGeneration) return thread.liveReload;
                    continue;\n}\n`;
                    source += addLabel(id, 'dispatch');
                    source += `switch (frame.locals[${idJS}].branch) {\n`;
                    for (const index of Object.keys(node.inputs.substacks)) {
                        source += `case ${+index}: { ${jump(branch(+index))} }\n`;
                    }
                    source += `default: { delete frame.locals[${idJS}]; ${popScope(id)}${jump(next)} } }\n`;
                    break;
                }
                const code = ordinary(block);
                if (/\byield\b/.test(code)) {
                    source += `state.pending++; try {\n${code}} finally { state.pending--; }
                        frame.pc = ${nextJS};
                        if (state.generation !== thread.blockContainer.editGeneration) return thread.liveReload;
                        continue;\n`;
                } else {
                    source += code;
                    if (address(ids[recordIndex + 1]) !== next || next === null) source += jump(next);
                }
            }
        }
        }
        source += '}\n';
        const loop = ['control_repeat', 'control_forever', 'control_repeat_until', 'control_while',
            'control_for_each'].includes(block.opcode);
        const hasBranch = loop || Object.keys(block.inputs).some(name => name.startsWith('SUBSTACK'));
        if (hasBranch) {
            source += addLabel(id, 'branchEnd');
            if (extensionBranch) {
                source += `if (frame.locals[${idJS}].info.isLoop) {
                    frame.pc = ${quote(address(id, 'test'))}; ${yieldLoop}continue;
                }
                delete frame.locals[${idJS}]; ${popScope(id)}${jump(next)}`;
            } else if (loop) source += `frame.pc = ${quote(address(id, 'test'))};\n${yieldLoop}continue;\n`;
            else source += `${popScope(id)}${jump(next)}`;
            source += '}\n';
        }
        recordIndex++;
    }
    source += 'default: { thread.liveExecution.repairFrame(state, frame); continue; }\n';
    source += '} }\n';
    let factorySource = '(function(thread) { const target = thread.target; const runtime = target.runtime;';
    factorySource += 'const stage = runtime.getTargetForStage();\n';
    for (const expression of Object.keys(js._setupVariables)) {
        factorySource += `const ${js._setupVariables[expression]} = ${expression};\n`;
    }
    factorySource += `return function*(state) { ${source} }; })`;
    return {factory: execute.scopedEval(factorySource), labels, procedures, blocks: new Set(records.keys())};
};

module.exports = {compile, address};
