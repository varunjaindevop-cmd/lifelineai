// Webpack loader: replaces import.meta references in onnxruntime-web
// with a runtime fallback so Terser (which parses as CJS) doesn't crash.
module.exports = function (source) {
  // import.meta.url → safe fallback that resolves at runtime
  return source.replace(
    /\bimport\.meta\b/g,
    "(typeof __webpack_public_path__!=='undefined'?{url:__webpack_public_path__}:{url:(typeof self!=='undefined'&&self.location?self.location.href:'')})"
  );
};
