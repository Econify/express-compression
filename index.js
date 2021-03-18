/*!
 * compression
 * Copyright(c) 2010 Sencha Inc.
 * Copyright(c) 2011 TJ Holowaychuk
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2014-2015 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict'

/**
 * Module dependencies.
 * @private
 */

var Buffer = require('safe-buffer').Buffer
var bytes = require('bytes')
var compressible = require('compressible')
var debug = require('debug')('compression')
var objectAssign = require('object-assign')
var onHeaders = require('on-headers')
var vary = require('vary')
var zlib = require('zlib')

var hasBrotliSupport = 'createBrotliCompress' in zlib

var supportedEncodings = hasBrotliSupport
  ? ['br', 'gzip', 'deflate', 'identity']
  : ['gzip', 'deflate', 'identity']

var preferredEncodings = hasBrotliSupport
  ? ['br', 'gzip']
  : ['gzip']

function negotiateEncoding (header) {
  header = header || ''

  var insts = header.split(',')
  var decoded = []

  for (var i = 0; i < insts.length; i++) {
    var inst = insts[i].match(/^\s*?([^\s;]+?)\s*?(?:;(.*))?$/)
    if (!inst) continue

    var encoding = inst[1]
    if (supportedEncodings.indexOf(encoding) === -1) {
      continue
    }

    var q = 1
    if (inst[2]) {
      var params = inst[2].split(';')
      for (var j = 0; j < params.length; j++) {
        var p = params[j].trim().split('=')
        if (p[0] === 'q') {
          q = parseFloat(p[1])
          break
        }
      }
    }

    if (q < 0 || q > 1) { // invalid
      continue
    }

    decoded.push({ encoding: encoding, q: q, i: i })
  }

  decoded.sort((a, b) => {
    if (a.q !== b.q) {
      return b.q - a.q // higher quality first
    }

    var aPreferred = preferredEncodings.indexOf(a.encoding)
    var bPreferred = preferredEncodings.indexOf(b.encoding)

    if (aPreferred === -1 && bPreferred === -1) {
      return a.i - b.i // consider the original order
    }

    if (aPreferred !== -1 && bPreferred !== -1) {
      return aPreferred - bPreferred // consider the preferred order
    }

    return aPreferred === -1 ? 1 : -1 // preferred first
  })

  if (decoded.length > 0) {
    return decoded[0].encoding
  }

  return null
}

/**
 * Module exports.
 */

module.exports = compression
module.exports.filter = shouldCompress

/**
 * Module variables.
 * @private
 */

var cacheControlNoTransformRegExp = /(?:^|,)\s*?no-transform\s*?(?:,|$)/

/**
 * Compress response data with gzip / deflate / brotli.
 *
 * @param {Object} [options]
 * @return {Function} middleware
 * @public
 */

function compression (options) {
  var opts = options || {}

  if (hasBrotliSupport) {
    // set the default level to a reasonable value with balanced speed/ratio
    if (opts.params === undefined) {
      opts = objectAssign({}, opts)
      opts.params = {}
    }

    if (opts.params[zlib.constants.BROTLI_PARAM_QUALITY] === undefined) {
      opts.params = objectAssign({}, opts.params)
      opts.params[zlib.constants.BROTLI_PARAM_QUALITY] = 4
    }
  }

  // options
  var filter = opts.filter || shouldCompress
  var threshold = bytes.parse(opts.threshold)

  if (threshold == null) {
    threshold = 1024
  }

  return function compression (req, res, next) {
    var ended = false
    var length
    var listeners = []
    var stream

    var _end = res.end
    var _on = res.on
    var _write = res.write

    // flush
    res.flush = function flush () {
      if (stream) {
        stream.flush()
      }
    }

    // proxy

    res.write = function write (chunk, encoding) {
      if (ended) {
        return false
      }

      if (!this._header) {
        this._implicitHeader()
      }

      return stream
        ? stream.write(toBuffer(chunk, encoding))
        : _write.call(this, chunk, encoding)
    }

    res.end = function end (chunk, encoding) {
      if (ended) {
        return false
      }

      if (!this._header) {
        // estimate the length
        if (!this.getHeader('Content-Length')) {
          length = chunkLength(chunk, encoding)
        }

        this._implicitHeader()
      }

      if (!stream) {
        return _end.call(this, chunk, encoding)
      }

      // mark ended
      ended = true

      // write Buffer for Node.js 0.8
      return chunk
        ? stream.end(toBuffer(chunk, encoding))
        : stream.end()
    }

    res.on = function on (type, listener) {
      if (!listeners || type !== 'drain') {
        return _on.call(this, type, listener)
      }

      if (stream) {
        return stream.on(type, listener)
      }

      // buffer listeners for future stream
      listeners.push([type, listener])

      return this
    }

    function nocompress (msg) {
      debug('no compression: %s', msg)
      addListeners(res, _on, listeners)
      listeners = null
    }

    onHeaders(res, function onResponseHeaders () {
      // determine if request is filtered
      if (!filter(req, res)) {
        nocompress('filtered')
        return
      }

      // determine if the entity should be transformed
      if (!shouldTransform(req, res)) {
        nocompress('no transform')
        return
      }

      // vary
      vary(res, 'Accept-Encoding')

      // content-length below threshold
      if (Number(res.getHeader('Content-Length')) < threshold || length < threshold) {
        nocompress('size below threshold')
        return
      }

      var encoding = res.getHeader('Content-Encoding') || 'identity'

      // already encoded
      if (encoding !== 'identity') {
        nocompress('already encoded')
        return
      }

      // head
      if (req.method === 'HEAD') {
        nocompress('HEAD request')
        return
      }

      // compression method
      var method = negotiateEncoding(req.headers['accept-encoding']) || 'identity'

      // negotiation failed
      if (method === 'identity') {
        nocompress('not acceptable')
        return
      }

      // compression stream
      debug('%s compression', method)
      stream = method === 'gzip'
        ? zlib.createGzip(opts)
        : method === 'br'
          ? zlib.createBrotliCompress(opts)
          : zlib.createDeflate(opts)

      // add buffered listeners to stream
      addListeners(stream, stream.on, listeners)

      // header fields
      res.setHeader('Content-Encoding', method)
      res.removeHeader('Content-Length')

      // compression
      stream.on('data', function onStreamData (chunk) {
        if (_write.call(res, chunk) === false) {
          stream.pause()
        }
      })

      stream.on('end', function onStreamEnd () {
        _end.call(res)
      })

      _on.call(res, 'drain', function onResponseDrain () {
        stream.resume()
      })
    })

    next()
  }
}

/**
 * Add bufferred listeners to stream
 * @private
 */

function addListeners (stream, on, listeners) {
  for (var i = 0; i < listeners.length; i++) {
    on.apply(stream, listeners[i])
  }
}

/**
 * Get the length of a given chunk
 */

function chunkLength (chunk, encoding) {
  if (!chunk) {
    return 0
  }

  return !Buffer.isBuffer(chunk)
    ? Buffer.byteLength(chunk, encoding)
    : chunk.length
}

/**
 * Default filter function.
 * @private
 */

function shouldCompress (req, res) {
  var type = res.getHeader('Content-Type')

  if (type === undefined || !compressible(type)) {
    debug('%s not compressible', type)
    return false
  }

  return true
}

/**
 * Determine if the entity should be transformed.
 * @private
 */

function shouldTransform (req, res) {
  var cacheControl = res.getHeader('Cache-Control')

  // Don't compress for Cache-Control: no-transform
  // https://tools.ietf.org/html/rfc7234#section-5.2.2.4
  return !cacheControl ||
    !cacheControlNoTransformRegExp.test(cacheControl)
}

/**
 * Coerce arguments to Buffer
 * @private
 */

function toBuffer (chunk, encoding) {
  return !Buffer.isBuffer(chunk)
    ? Buffer.from(chunk, encoding)
    : chunk
}
