var createError = require('http-errors');
var express = require('express');
var cors = require('cors');
var favicon = require('serve-favicon');
var path = require('path');


var indexRouter = require('./routes/index');
var githubRouter = require('./routes/github');
var spotifyRouter = require('./routes/spotify');
var unsplashRouter = require('./routes/unsplash');

var app = express();
app.use(favicon(path.join(__dirname, 'public', 'pixlinkcar.png')));

// Minimal API server configuration
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Strict CORS for the frontend only
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (origin === 'https://joestar.vercel.app' || 'https://joestar.is-a.dev') return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));

app.use('/public', express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/github', githubRouter);
app.use('/spotify', spotifyRouter);
app.use('/unsplash', unsplashRouter);

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  next(createError(404));
});

// error handler: serve HTML 404 page when appropriate, otherwise JSON
app.use(function (err, req, res, next) {
  const status = err.status || 500;
  if (req.accepts('html')) {
    return res.status(status).sendFile(path.join(__dirname, 'public', status === 404 ? '404.html' : '404.html'));
  }
  return res.status(status).json({ message: err.message });
});

module.exports = app;
