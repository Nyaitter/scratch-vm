const readLocal = (vm, request = {}) => {
    const runtime = vm.runtime;
    const target = runtime.getTargetById(request.targetId) || vm.editingTarget || runtime.getTargetForStage();
    switch (request.kind) {
    case 'variable': {
        const variable = target?.lookupVariableById(request.id);
        return variable ? JSON.parse(JSON.stringify(variable.value)) : null;
    }
    case 'target':
        return target ? {id: target.id,
            name: target.getName(),
            x: target.x,
            y: target.y,
            direction: target.direction,
            size: target.size,
            visible: target.visible,
            currentCostume: target.currentCostume,
            volume: target.volume} : null;
    case 'options':
        // Preserve Infinity (unlimited clones) until the transport encodes it.
        return require('@turbowarp/json').stringify(runtime._generateAllProjectOptions());
    case 'timer':
        return runtime.ioDevices.clock.projectTimer();
    case 'answer':
        return runtime._primitives.sensing_answer();
    default:
        throw new Error(`Unknown Nditor host value: ${request.kind}`);
    }
};

const createAPI = vm => ({
    version: 1,
    get isHost () {
        return vm.runtime._nditorCollaborationRole !== 'guest';
    },
    readHost: async request => {
        if (vm.runtime._nditorCollaborationRole === 'guest' && vm._nditorHostRead) {
            const value = await vm._nditorHostRead(request);
            return value;
        }
        return readLocal(vm, request);
    }
});

module.exports = {readLocal, createAPI};
