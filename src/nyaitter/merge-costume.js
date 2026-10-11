const {parseDOM, DomUtils} = require('htmlparser2');
const {Buffer} = require('buffer');
const Base64 = require('../util/base64-util');

const MAX_PIXELS = 16 * 1024 * 1024;
const decodeText = data => new TextDecoder().decode(Base64.base64ToUint8Array(data));
const encodeText = data => Base64.uint8ArrayToBase64(new TextEncoder().encode(data));
const multiply = (a, b) => [
    (a[0] * b[0]) + (a[2] * b[1]), (a[1] * b[0]) + (a[3] * b[1]),
    (a[0] * b[2]) + (a[2] * b[3]), (a[1] * b[2]) + (a[3] * b[3]),
    (a[0] * b[4]) + (a[2] * b[5]) + a[4], (a[1] * b[4]) + (a[3] * b[5]) + a[5]
];
const matrix = text => {
    let result = [1, 0, 0, 1, 0, 0];
    for (const match of String(text || '').matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
        const n = match[2].trim().split(/[\s,]+/)
            .map(Number);
        let next = [1, 0, 0, 1, 0, 0];
        if (match[1] === 'matrix') next = n;
        if (match[1] === 'translate') next = [1, 0, 0, 1, n[0], n[1] || 0];
        if (match[1] === 'scale') next = [n[0], 0, 0, n.length > 1 ? n[1] : n[0], 0, 0];
        if (match[1] === 'rotate') {
            const angle = n[0] * Math.PI / 180;
            next = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];
            if (n.length > 1) {
                next = multiply(multiply([1, 0, 0, 1, n[1], n[2]], next),
                    [1, 0, 0, 1, -n[1], -n[2]]);
            }
        }
        if (match[1] === 'skewX') next[2] = Math.tan(n[0] * Math.PI / 180);
        if (match[1] === 'skewY') next[1] = Math.tan(n[0] * Math.PI / 180);
        result = multiply(result, next);
    }
    return result;
};
const fingerprintCache = new WeakMap();
const fingerprint = node => {
    if (fingerprintCache.has(node)) return fingerprintCache.get(node);
    const value = JSON.stringify([node.type, node.name, node.data,
    Object.keys(node.attribs || {}).filter(key => key !== 'id')
        .sort()
        .map(key => [key, node.attribs[key]]),
    (node.children || []).map(fingerprint)]);
    fingerprintCache.set(node, value);
    return value;
};
const normalizeSVG = costume => {
    const text = decodeText(costume.assetData.data);
    const root = parseDOM(text, {xmlMode: true, decodeEntities: true}).find(node => node.name === 'svg');
    if (!root) throw new Error('Invalid SVG costume');
    const box = String(root.attribs.viewBox || '').trim()
        .split(/[\s,]+/)
        .map(Number);
    const width = parseFloat(root.attribs.width) || box[2] || 1;
    const height = parseFloat(root.attribs.height) || box[3] || 1;
    const sx = box.length === 4 && box[2] ? width / box[2] : 1;
    const sy = box.length === 4 && box[3] ? height / box[3] : 1;
    const x = Number(costume.rotationCenterX) || 0;
    const y = Number(costume.rotationCenterY) || 0;
    const transform = [sx, 0, 0, sy, -x - ((box[0] || 0) * sx), -y - ((box[1] || 0) * sy)];
    const references = new Set([...text.matchAll(/(?:url\(#|href=["']#)([^)"']+)/g)].map(match => match[1]));
    const normalize = (nodes, inherited, parentName) => nodes.flatMap(node => {
        if (node.type === 'text' && !node.data.trim() && !['text', 'tspan', 'style'].includes(parentName)) return [];
        if (!node.attribs) return [node];
        if (node.name === 'defs' || node.name === 'style') return [node];
        const combined = multiply(inherited, matrix(node.attribs.transform));
        if (node.name === 'g' && !references.has(node.attribs.id) &&
            Object.keys(node.attribs).every(key => key === 'id' || key === 'transform')) {
            return normalize(node.children || [], combined, node.name);
        }
        node.attribs.transform = `matrix(${combined.map(n => Math.round(n * 1e8) / 1e8).join(',')})`;
        return [node];
    });
    root.children = normalize(root.children || [], transform, 'svg');
    return {root, left: -x, top: -y, width, height};
};
const align = (base, items) => {
    const used = new Set();
    const assigned = new Map();
    const ids = new Map();
    const signatures = new Map();
    base.forEach((node, i) => {
        const id = node.attribs && node.attribs.id;
        if (id) { if (!ids.has(id)) ids.set(id, []); ids.get(id).push(i); }
        const signature = fingerprint(node);
        if (!signatures.has(signature)) signatures.set(signature, []);
        signatures.get(signature).push(i);
    });
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const id = item.attribs && item.attribs.id;
        let index = id ? (ids.get(id) || []).find(n => !used.has(n)) : undefined;
        if (index === undefined) {
            index = (signatures.get(fingerprint(item)) || []).find(n => !used.has(n));
        }
        if (index !== undefined) {
            used.add(index); assigned.set(i, `b:${index}`);
        }
    }
    const occurrences = new Map();
    const result = new Map();
    items.forEach((item, i) => {
        let key = assigned.get(i);
        if (!key && i < base.length && !used.has(i)) {
            used.add(i); key = `b:${i}`;
        }
        if (!key) {
            const identity = (item.attribs && item.attribs.id) || fingerprint(item);
            const occurrence = occurrences.get(identity) || 0;
            occurrences.set(identity, occurrence + 1);
            key = `n:${identity}:${occurrence}`;
        }
        result.set(key, item);
    });
    return result;
};
const mergeNode = (base, current, incoming, canonicalOrder) => {
    if (!incoming) return null;
    if (!base) return incoming;
    if (fingerprint(incoming) === fingerprint(base)) return current;
    if (!current || incoming.name !== base.name || current.name !== base.name || !incoming.attribs) return incoming;
    const result = {...current, attribs: {...current.attribs}};
    for (const key of new Set([...Object.keys(base.attribs || {}), ...Object.keys(incoming.attribs)])) {
        if (incoming.attribs[key] !== base.attribs[key]) {
            if (Object.prototype.hasOwnProperty.call(incoming.attribs, key)) {
                result.attribs[key] = incoming.attribs[key];
            } else delete result.attribs[key];
        }
    }
    const original = base.children || [];
    const left = align(original, current.children || []);
    const right = align(original, incoming.children || []);
    const incomingBase = [...right.keys()].filter(key => key.startsWith('b:'));
    const reordered = incomingBase.some((key, i) => i > 0 &&
        Number(key.slice(2)) < Number(incomingBase[i - 1].slice(2)));
    const keys = canonicalOrder || reordered ?
        [...right.keys(), ...[...left.keys()].filter(key => !right.has(key) && !key.startsWith('b:'))] :
        [...left.keys()].filter(key => !key.startsWith('b:') || right.has(key))
            .concat([...right.keys()].filter(key => !left.has(key)));
    result.children = keys.map(key => mergeNode(key.startsWith('b:') ? original[Number(key.slice(2))] : null,
        left.get(key), right.has(key) ? right.get(key) : left.get(key), canonicalOrder)).filter(Boolean);
    return result;
};
const mergeMetadata = (base, current, incoming) => {
    const merged = {...current};
    for (const key of Object.keys(incoming)) {
        if (key === 'assetData' || key === 'assetId' || key === 'md5') continue;
        if (JSON.stringify(incoming[key]) !== JSON.stringify(base[key])) merged[key] = incoming[key];
    }
    return merged;
};
const mergeVectorCostumes = (base, current, incoming, canonicalOrder = false) => {
    if ((base.assetData.assetId && current.assetData.assetId === base.assetData.assetId) ||
        current.assetData.data === base.assetData.data) {
        return {...incoming, name: incoming.name === base.name ? current.name : incoming.name};
    }
    const b = normalizeSVG(base); const c = normalizeSVG(current); const n = normalizeSVG(incoming);
    const root = mergeNode(b.root, c.root, n.root, canonicalOrder);
    const left = Math.min(c.left, n.left); const top = Math.min(c.top, n.top);
    const width = Math.max(c.left + c.width, n.left + n.width) - left;
    const height = Math.max(c.top + c.height, n.top + n.height) - top;
    Object.assign(root.attribs, {width: String(width),
        height: String(height),
        viewBox: `${left} ${top} ${width} ${height}`});
    const merged = mergeMetadata(base, current, incoming);
    Object.assign(merged, {rotationCenterX: -left, rotationCenterY: -top, size: [width, height]});
    merged.assetData = {dataFormat: 'svg',
        assetId: null,
        data: encodeText(DomUtils.getOuterHTML(root, {xmlMode: true, decodeEntities: true}))};
    delete merged.assetId; delete merged.md5;
    return merged;
};
const decodePNG = async source => {
    const bytes = Base64.base64ToUint8Array(source.assetData.data);
    const header = Buffer.from(bytes);
    if (header.length < 24 || header.readUInt32BE(16) * header.readUInt32BE(20) > MAX_PIXELS) {
        throw new Error('Costume image is too large to merge');
    }
    if (typeof document === 'undefined') {
        const module = await import('pngjs/lib/png-sync.js');
        return (module.default || module).read(header);
    }
    const url = URL.createObjectURL(new Blob([bytes], {type: 'image/png'}));
    try {
        const image = new Image();
        await new Promise((resolve, reject) => {
            image.onload = resolve; image.onerror = reject; image.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d', {willReadFrequently: true});
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
    } finally {
        URL.revokeObjectURL(url);
    }
};
const encodePNG = async image => {
    if (typeof document === 'undefined') {
        const module = await import('pngjs/lib/png-sync.js');
        return (module.default || module).write(image);
    }
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    const data = ctx.createImageData(image.width, image.height);
    data.data.set(image.data); ctx.putImageData(data, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Unable to encode merged costume');
    return new Uint8Array(await blob.arrayBuffer());
};
const mergeCostumeUpdate = async (base, current, incoming, canonicalOrder = false) => {
    if (!base || !base.assetData || !current.assetData || !incoming.assetData) return incoming;
    const format = incoming.assetData.dataFormat;
    if (format !== base.assetData.dataFormat || format !== current.assetData.dataFormat) return incoming;
    if ((base.assetData.assetId && current.assetData.assetId === base.assetData.assetId) ||
        current.assetData.data === base.assetData.data) {
        return {...incoming, name: incoming.name === base.name ? current.name : incoming.name};
    }
    if (format === 'svg') return mergeVectorCostumes(base, current, incoming, canonicalOrder);
    if (format !== 'png' || current.bitmapResolution !== incoming.bitmapResolution) return incoming;
    const images = await Promise.all([decodePNG(base), decodePNG(current), decodePNG(incoming)]);
    const costumes = [base, current, incoming];
    const scales = costumes.map(costume => (incoming.bitmapResolution || 1) / (costume.bitmapResolution || 1));
    const positions = costumes.map((costume, index) => [
        -Math.round((costume.rotationCenterX || 0) * scales[index]),
        -Math.round((costume.rotationCenterY || 0) * scales[index])]);
    const left = Math.min(positions[1][0], positions[2][0]); const top = Math.min(positions[1][1], positions[2][1]);
    const width = Math.max(positions[1][0] + images[1].width, positions[2][0] + images[2].width) - left;
    const height = Math.max(positions[1][1] + images[1].height, positions[2][1] + images[2].height) - top;
    if (width * height > MAX_PIXELS) throw new Error('Merged costume image is too large');
    const output = Buffer.alloc(width * height * 4);
    const pixel = (index, x, y) => {
        x = Math.floor((x - positions[index][0]) / scales[index]);
        y = Math.floor((y - positions[index][1]) / scales[index]);
        const image = images[index];
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) return 0;
        const offset = ((y * image.width) + x) * 4;
        if (image.data[offset + 3] === 0) return 0;
        return ((image.data[offset] << 24) | (image.data[offset + 1] << 16) |
            (image.data[offset + 2] << 8) | image.data[offset + 3]) >>> 0;
    };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const original = pixel(0, x + left, y + top); const remote = pixel(2, x + left, y + top);
            output.writeUInt32BE(remote === original ? pixel(1, x + left, y + top) : remote, ((y * width) + x) * 4);
        }
    }
    const merged = mergeMetadata(base, current, incoming);
    Object.assign(merged, {rotationCenterX: -left, rotationCenterY: -top, size: [width, height]});
    merged.assetData = {assetId: null,
        dataFormat: 'png',
        data: Base64.uint8ArrayToBase64(await encodePNG({width, height, data: output}))};
    delete merged.assetId; delete merged.md5;
    return merged;
};

module.exports = {mergeCostumeUpdate, mergeVectorCostumes};
