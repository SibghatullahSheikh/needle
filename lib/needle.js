//////////////////////////////////////////
// Needle -- Node.js HTTP Client
// Written by Tomás Pollak <tomas@forkhq.com>
// (c) 2012-2013 - Fork Ltd.
// MIT Licensed
//////////////////////////////////////////

var fs          = require('fs'),
    http        = require('http'),
    https       = require('https'),
    url         = require('url'),
    stream      = require('stream'),
    stringify   = require('qs').stringify,
    multipart   = require('./multipart'),
    auth        = require('./auth'),
    parsers     = require('./parsers'),
    decoder     = require('./decoder');

//////////////////////////////////////////
// variabilia
//////////////////////////////////////////

var version     = JSON.parse(fs.readFileSync(__dirname + '/../package.json').toString()).version,
    debugging   = !!process.env.DEBUG,
    debug       = debugging ? console.log : function() { /* noop */ };

var user_agent  = 'Needle/' + version;
user_agent     += ' (Node.js ' + process.version + '; ' + process.platform + ' ' + process.arch + ')';

var node_tls_opts = 'agent pfx key passphrase cert ca ciphers rejectUnauthorized secureProtocol';

//////////////////////////////////////////
// decompressors for gzip/deflate bodies
//////////////////////////////////////////

var decompressors = {};

try {

  var zlib = require('zlib')

  decompressors['x-deflate'] = zlib.Inflate;
  decompressors['deflate']   = zlib.Inflate;
  decompressors['x-gzip']    = zlib.Gunzip;
  decompressors['gzip']      = zlib.Gunzip;

} catch(e) { /* zlib not available */ }

//////////////////////////////////////////
// defaults
//////////////////////////////////////////

var defaults = {
  accept          : '*/*',
  connection      : 'close',
  user_agent      : user_agent,
  follow          : 0,
  decode_response : true,
  parse_response  : true,
  timeout         : 10000,
  encoding        : 'utf8',
  boundary        : '--------------------NODENEEDLEHTTPCLIENT'
}

//////////////////////////////////////////
// the main act
//////////////////////////////////////////

var Needle = {

  request: function(method, uri, data, options, callback) {

    var self     = this,
        out      = new stream.PassThrough({ objectMode: false }),
        callback = (typeof options == 'function') ? options : callback,
        options  = options || {};

    // if no 'http' is found on URL, prepend it
    if (uri.indexOf('http') == -1) uri = 'http://' + uri;

    var config = {
      base_opts       : {},
      proxy           : options.proxy,
      output          : options.output,
      encoding        : options.encoding || (options.multipart ? 'binary' : defaults.encoding),
      decode_response : options.decode === false ? false : defaults.decode_response,
      parse_response  : options.parse === false ? false : defaults.parse_response,
      follow          : options.follow === true ? 10 : typeof options.follow == 'number' ? options.follow : defaults.follow,
      timeout         : (typeof options.timeout == 'number') ? options.timeout : defaults.timeout
    }

    // if any of node's TLS options are passed, let them be passed to https.request()
    node_tls_opts.split(' ').forEach(function(key) {
      if (typeof options[key] != 'undefined') {
        config.base_opts[key] = options[key];
        if (typeof options.agent == 'undefined')
          config.base_opts.agent = false; // otherwise tls options are skipped
      }
    });

    config.headers = {
      'Accept'     : options.accept     || defaults.accept,
      'Connection' : options.connection || defaults.connection,
      'User-Agent' : options.user_agent || defaults.user_agent
    }

    if (options.compressed && typeof zlib != 'undefined')
      config.headers['Accept-Encoding'] = 'gzip,deflate';

    for (var h in options.headers)
      config.headers[h] = options.headers[h];

    if (options.username) {
      if (options.auth && (options.auth == 'auto' || options.auth == 'digest')) {
        config.credentials = [options.username, options.password];
      } else {
        var auth_header = options.proxy ? 'Proxy-Authorization' : 'Authorization';
        config.headers[auth_header] = auth.basic(options.username, options.password);
      }
    }

    if (data) {
      if (method.toUpperCase() == 'GET') { // build query string and append to URI

        uri  = uri.replace(/\?.*|$/, '?' + stringify(data));
        data = null;

      } else if (options.multipart) { // build multipart body for request

        var boundary = options.boundary || defaults.boundary;

        multipart.build(data, boundary, function(err, body) {
          if (err) throw(err);

          config.headers['Content-Type']   = 'multipart/form-data; boundary=' + boundary;
          config.headers['Content-Length'] = body.length;
          self.send_request(1, method, uri, config, body, out, callback);
        });

        return out; // stream

      } else { // format data according to content type, and send request

        var post_data = (typeof(data) === 'string') ? data :
            options.json ? JSON.stringify(data) : stringify(data);

        if (!config.headers['Content-Type']) {
          config.headers['Content-Type'] = options.json
          ? 'application/json'
          : 'application/x-www-form-urlencoded';
        }

        post_data = new Buffer(post_data, config.encoding);
        config.headers['Content-Length'] = post_data.length;

      }
    }

    return this.send_request(1, method, uri, config, post_data, out, callback);
  },

  get_request_opts: function(method, uri, config) {
    var opts      = config.base_opts,
        proxy     = config.proxy,
        remote    = proxy ? url.parse(proxy) : url.parse(uri);

    opts.protocol = remote.protocol;
    opts.host     = remote.hostname;
    opts.port     = remote.port || (remote.protocol == 'https:' ? 443 : 80);
    opts.path     = proxy ? uri : remote.pathname + (remote.search || '');
    opts.method   = method;
    opts.headers  = config.headers;

    opts.headers['Host'] = proxy ? url.parse(uri).hostname : remote.hostname;
    if (opts.port != 80 && opts.port != 443)
      opts.headers['Host'] += ':' + opts.port;

    return opts;
  },

  get_auth_header: function(header, credentials, request_opts) {
    var type = header.split(' ')[0],
        user = credentials[0],
        pass = credentials[1];

    if (type == 'Digest') {
      return auth.digest(header, user, pass, request_opts.method, request_opts.path);
    } else if (type == 'Basic') {
      return auth.basic(user, pass);
    }
  },

  send_request: function(count, method, uri, config, post_data, out, callback) {

    var timer,
        self               = this,
        request_opts       = this.get_request_opts(method, uri, config),
        protocol           = request_opts.protocol == 'https:' ? https : http,
        callback_requested = (callback ? true : false);

    debug('Making request #' + count, request_opts);
    var request = protocol.request(request_opts, function(resp) {

      var headers = resp.headers;
      debug('Got response', headers);
      if (timer) clearTimeout(timer);

      // if redirect code is found, send a GET request to that location if enabled via 'follow' option
      if ([301, 302].indexOf(resp.statusCode) != -1 && headers.location) {
        if (count <= config.follow)
          return self.send_request(++count, 'GET', url.resolve(uri, headers.location), config, null, out, callback);
        else if (config.follow > 0)
          return callback(new Error('Max redirects reached. Possible loop in: ' + headers.location));
      }

      // if authentication is requested and credentials were not passed, resend request if we have user/pass
      if (resp.statusCode == 401 && headers['www-authenticate'] && config.credentials) {
        if (!config.headers['Authorization']) { // only if authentication hasn't been sent
          var auth_header = self.get_auth_header(headers['www-authenticate'], config.credentials, request_opts);

          if (auth_header) {
            config.headers['Authorization'] = auth_header;
            return self.send_request(count, method, uri, config, post_data, out, callback);
          }
        }
      }

      var pipeline      = [],
          parsed        = false,
          mime          = self.parse_content_type(headers['content-type']),
          text_response = mime.type && mime.type.indexOf('text/') != -1;

      // To start, if our body is compressed and we're able to inflate it, do it.
      if (headers['content-encoding'] && decompressors[headers['content-encoding']]) {
        pipeline.push(decompressors[headers['content-encoding']]());
      }

      // If parse is enabled and we have a parser for it, then go for it.
      if (config.parse_response && parsers[mime.type]) {
        parsed = true;
        pipeline.push(parsers[mime.type]());

        // set objectMode on out stream to improve performance
        out._writableState.objectMode = true;
        out._readableState.objectMode = true;

      // If we're not parsing, and unless decoding was disabled, we'll try
      // decoding non UTF-8 bodies to UTF-8, using the iconv-lite library.
      } else if (text_response && config.decode_response
        && mime.charset && !mime.charset.match(/utf-?8$/i)) {
          pipeline.push(decoder(mime.charset));
      }

      // And `out` is the stream we finally push the decoded/parsed output to.
      pipeline.push(out);

      // Process the pipeline!
      var tmp = resp;
      while (pipeline.length) {
        tmp = tmp.pipe(pipeline.shift());
      }

      // If the user has requested and output file, pipe the output stream to it.
      // In stream mode, we will still get the response stream to play with.
      if (config.output && resp.statusCode == 200) {
        resp.pipe(fs.createWriteStream(config.output))
      }

      // Only aggregate the full body if a callback was requested.
      if (callback_requested) {
        resp.body  = [];
        resp.bytes = 0;

        // Count the amount of (raw) bytes passed using a PassThrough stream.
        var bytesCounter = new stream.PassThrough();
        resp.pipe(bytesCounter);

        bytesCounter.on('readable', function() {
          while (chunk = this.read()) {
            resp.bytes += chunk.length;
          }
        })

        // Listen on the 'readable' event to aggregate the chunks.
        out.on('readable', function() {
          while (chunk = this.read()) {
            // We're either pushing buffers or objects, never strings.
            if (typeof chunk == 'string') chunk = new Buffer(chunk);

            // Push all chunks to resp.body. We'll bind them in resp.end().
            resp.body.push(chunk);
          }
        })

        // And set the .body property once all data is in.
        out.on('end', function() {

          // if parse was successful, we should have an array with one object
          if (resp.body[0] && !Buffer.isBuffer(resp.body[0])) {
            resp.body = resp.body[0];
          } else { // we got one or several buffers
            resp.body = Buffer.concat(resp.body);

            // if we got a text response, of parsing failed, stringify it
            if (text_response || parsed)
              resp.body = resp.body.toString();
          }

          callback(null, resp, resp.body);
        });

      };
    });

    // unless timeout was disabled, set a timeout to abort the request
    if (config.timeout > 0) {
      timer = setTimeout(function() {
        request.abort();
      }, config.timeout)
    }

    request.on('error', function(err) {
      debug('Request error', err);
      if (timer) clearTimeout(timer);
      if (callback) callback(err || new Error('Unknown error when making request.'));
    });

    if (post_data) request.write(post_data, config.encoding);
    request.end();

    return out;
  },

  parse_content_type: function(header) {
    if (!header || header == '') return {};

    var charset = 'iso-8859-1', arr = header.split(';');
    try { charset = arr[1].match(/charset=(.+)/)[1] } catch (e) { /* not found */ }

    return { type: arr[0], charset: charset };
  }
}

exports.version = version;

exports.defaults = function(obj) {
  for (var key in obj) {
    if (defaults[key] && typeof obj[key] != 'undefined')
      defaults[key] = obj[key];
  }
  return defaults;
}

'head get'.split(' ').forEach(function(method) {
  exports[method] = function(uri, options, callback) {
    return Needle.request(method, uri, null, options, callback);
  }
})

'post put delete'.split(' ').forEach(function(method) {
  exports[method] = function(uri, data, options, callback) {
    return Needle.request(method, uri, data, options, callback);
  }
})

exports.request = function(method, uri, data, opts, callback) {
  return Needle.request(method.toUpperCase(), uri, data, opts, callback);
};
