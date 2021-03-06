'use strict'

var stream = require('readable-stream')
var eos = require('end-of-stream')
var shift = require('stream-shift')

var SIGNAL_FLUSH = new Buffer([0])

var onuncork = (self, fn) => {
  if (self._corked) self.once('uncork', fn)
  else fn()
}

var destroyer = (self, end) => (err) => {
  if (err) self.destroy(err.message === 'premature close' ? null : err)
  else if (end && !self._ended) self.end()
}

var end = (ws, fn) => {
  if (!ws) return fn()
  if (ws._writableState && ws._writableState.finished) return fn()
  if (ws._writableState) return ws.end(fn)
  ws.end()
  fn()
}

var toStreams2 = (rs) => new stream.Readable({ objectMode: true, highWaterMark: 16 }).wrap(rs)

class Duplexer extends stream.Duplex {
  constructor (writable, readable, opts) {
    super(opts)

    this._writable = null
    this._readable = null
    this._readable2 = null

    this._forwardDestroy = !opts || opts.destroy !== false
    this._forwardEnd = !opts || opts.end !== false
    this._corked = 1 // start corked
    this._ondrain = null
    this._drained = false
    this._forwarding = false
    this._unwrite = null
    this._unread = null
    this._ended = false

    this.destroyed = false

    if (writable) this.setWritable(writable)
    if (readable) this.setReadable(readable)
  }

  static obj (writable, readable, opts) {
    if (!opts) opts = {}
    opts.objectMode = true
    opts.highWaterMark = 16
    return new Duplexer(writable, readable, opts)
  }

  cork () {
    if (++this._corked === 1) this.emit('cork')
  }

  uncork () {
    if (this._corked && --this._corked === 0) this.emit('uncork')
  }

  setWritable (writable) {
    if (this._unwrite) this._unwrite()

    if (this.destroyed) {
      if (writable && writable.destroy) writable.destroy()
      return
    }

    if (writable === null || writable === false) {
      this.end()
      return
    }

    var unend = eos(writable, {
      writable: true,
      readable: false
    }, destroyer(this, this._forwardEnd))

    var ondrain = () => {
      var ondrain = this._ondrain
      this._ondrain = null
      if (ondrain) ondrain()
    }

    var clear = () => {
      this._writable.removeListener('drain', ondrain)
      unend()
    }

    if (this._unwrite) process.nextTick(ondrain) // force a drain on stream reset to avoid livelocks

    this._writable = writable
    this._writable.on('drain', ondrain)
    this._unwrite = clear

    this.uncork() // always uncork setWritable
  }

  setReadable (readable) {
    if (this._unread) this._unread()

    if (this.destroyed) {
      if (readable && readable.destroy) readable.destroy()
      return
    }

    if (readable === null || readable === false) {
      this.push(null)
      this.resume()
      return
    }

    var unend = eos(readable, {
      writable: false,
      readable: true
    }, destroyer(this))

    var onreadable = () => {
      this._forward()
    }

    var onend = () => {
      this.push(null)
    }

    var clear = () => {
      this._readable2.removeListener('readable', onreadable)
      this._readable2.removeListener('end', onend)
      unend()
    }

    this._drained = true
    this._readable = readable
    this._readable2 = readable._readableState ? readable : toStreams2(readable)
    this._readable2.on('readable', onreadable)
    this._readable2.on('end', onend)
    this._unread = clear

    this._forward()
  }

  _read () {
    this._drained = true
    this._forward()
  }

  _forward () {
    if (this._forwarding || !this._readable2 || !this._drained) return
    this._forwarding = true

    var data
    while (this._drained && (data = shift(this._readable2)) !== null) {
      if (this.destroyed) continue
      this._drained = this.push(data)
    }

    this._forwarding = false
  }

  destroy (err) {
    if (this.destroyed) return
    this.destroyed = true
    process.nextTick(() => this._destroy(err))
  }

  _destroy (err) {
    if (err) {
      var ondrain = this._ondrain
      this._ondrain = null
      if (ondrain) ondrain(err)
      else this.emit('error', err)
    }

    if (this._forwardDestroy) {
      if (this._readable && this._readable.destroy) this._readable.destroy()
      if (this._writable && this._writable.destroy) this._writable.destroy()
    }

    this.emit('close')
  }

  _write (data, enc, cb) {
    if (this.destroyed) return cb()
    if (this._corked) return onuncork(this, () => this._write(data, enc, cb))
    if (data === SIGNAL_FLUSH) return this._finish(cb)
    if (!this._writable) return cb()

    if (this._writable.write(data) === false) this._ondrain = cb
    else cb()
  }

  _finish (cb) {
    this.emit('preend')
    onuncork(this, () => {
      end(this._forwardEnd && this._writable, () => {
        // haxx to not emit prefinish twice
        if (this._writableState.prefinished === false) this._writableState.prefinished = true
        this.emit('prefinish')
        onuncork(this, cb)
      })
    })
  }

  end (data, enc, cb) {
    if (typeof data === 'function') return this.end(null, null, data)
    if (typeof enc === 'function') return this.end(data, null, enc)
    this._ended = true
    if (data) this.write(data)
    if (!this._writableState.ending) this.write(SIGNAL_FLUSH)
    return super.end(cb)
  }
}

module.exports = Duplexer
