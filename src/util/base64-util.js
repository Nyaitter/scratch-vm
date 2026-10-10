class Base64Util {
    static base64ToUint8Array (base64) {
        if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(base64);
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    static uint8ArrayToBase64 (array) {
        const bytes = array instanceof Uint8Array ? array : new Uint8Array(array);
        if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
        const chunks = [];
        for (let i = 0; i < bytes.length; i += 0x8000) {
            chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
        }
        return btoa(chunks.join(''));
    }

    static arrayBufferToBase64 (buffer) {
        return Base64Util.uint8ArrayToBase64(new Uint8Array(buffer));
    }
}

module.exports = Base64Util;
