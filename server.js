#!/bin/env node

var express = require('express');
var io = require('socket.io');
var http = require('http');

var path = require('path');
var _ = require('lodash');
var fs = require('fs');

var routes = require('./routes');
var models = require('./models');
var sockets = require('./sockets');

var mongoose = require('mongoose');

// Auth libs
var passport = require('passport');
var LocalStrategy = require('passport-local').Strategy;
var flash = require('connect-flash');

var ensureAuthenticated = function(url, admin) {
    return function(req, res, next) {
        if (!req.isAuthenticated || !req.isAuthenticated()) {
            return res.redirect(url);
        } else if (admin && (!req.user || !req.user.isAdmin)) {
            return res.redirect(url);
        }
        next();
    };
};

/**
 * Configuration app for SwiftCODE
 */
var SwiftCODEConfig = function() {
    // Setup configuration from the environment
    var self = this;

    // Setup a flag indicating if we're in OpenShift or not
    self.openshift = !!process.env.OPENSHIFT_APP_DNS;
    self.repo = process.env.OPENSHIFT_REPO_DIR || './';

    self.ipaddress = process.env.OPENSHIFT_NODEJS_IP || '127.0.0.1';
    self.port = process.env.OPENSHIFT_NODEJS_PORT || 8080;

    self.mongodb = {
        dbname: 'swiftcode',
        host: process.env.OPENSHIFT_MONGODB_DB_HOST || 'localhost',
        port: process.env.OPENSHIFT_MONGODB_DB_PORT || 27017,
        username: process.env.OPENSHIFT_MONGODB_DB_USERNAME || 'admin',
        password: process.env.OPENSHIFT_MONGODB_DB_PASSWORD || 'password'
    };
};

var SwiftCODE = function() {
    var self = this;

    /**
     * Listen on the configured port and IP
     */
    self.listen = function() {
        self.server = http.createServer(self.app);

        // Socket.IO server needs to listen in the same block as the HTTP
        // server, or you'll get listen EACCES errors (due to Node's context
        // switching?)
        self.io = io.listen(self.server);
        self.server.listen(self.config.port, self.config.ipaddress);
        self.sockets.listen(self.io);

        if (self.config.openshift) {
            self.sockets.configureForOpenShift();
        }
        console.log('Listening at ' + self.config.ipaddress + ':' + self.config.port);
    };

    self._initialize = function() {
        self._setupConfig();
        self._setupDb();
        self._setupAuth();
        self._setupApp();
        self._setupRoutes();
        self._setupSockets();
    };

    self._setupConfig = function() {
        self.config = new SwiftCODEConfig();
    };

    /**
     * Setup database connection
     */
    self._setupDb = function() {
        mongoose.connect('mongodb://' + self.config.mongodb.host + ':' + self.config.mongodb.port + '/' + self.config.mongodb.dbname, {
            user: self.config.mongodb.username,
            pass: self.config.mongodb.password
        });

        models.Game.resetIncomplete();
        models.User.resetCurrentGames();
    };

    /**
     * Setup authentication and user config
     */
    self._setupAuth = function() {
        passport.use(new LocalStrategy(function(username, password, done) {
            models.User.findOne({ username: username }, function(err, user) {
                if (err) {
                    console.log(err);
                    return done(err);
                }
                // Respond with a message if no such user exists
                if (!user) {
                    return done(null, false, { message: 'No such user exists.' });
                }
                // Otherwise check the password
                user.comparePassword(password, function(err, isMatch) {
                    if (err) {
                        console.log(err);
                        return done(err);
                    }
                    if (!isMatch) {
                        return done(null, false, { message: 'Looks like that was an incorrect password.' });
                    }
                    return done(null, user);
                });
            });
        }));

        passport.serializeUser(function(user, done) {
            done(null, user.id);
        });

        passport.deserializeUser(function(id, done) {
            models.User.findById(id, function(err, user) {
                done(null, user);
            });
        });
    };

    /**
     * Setup app configuration
     */
    self._setupApp = function() {
        self.app = express();
        self.app.configure(function() {
            self.app.set('views', path.join(self.config.repo, 'views'));
            self.app.set('view engine', 'jade');

            self.app.use(express.favicon(path.join(self.config.repo, 'public/img/favicon.ico')));
            self.app.use(express.json());

            // Do not use bodyParser, which include express.multipart, which
            // has a problem with creating tmp files on every request
            self.app.use(express.urlencoded());
            self.app.use(express.methodOverride());

            self.app.use(express.cookieParser());
            // TODO: Replace this secret with a proper system
            self.app.use(express.session({ secret: 'temporarysecret', }));
            self.app.use(flash());

            self.app.use(passport.initialize());
            self.app.use(passport.session());

            // Template default available attributes
            self.app.use(function(req, res, next) {
                res.locals({
                    user: req.user,
                    path: req.path,
                    openshift: self.config.openshift
                });
                next();
            });

            self.app.use(self.app.router);
            self.app.use(express.static(path.join(self.config.repo, 'public')));
        });

        self.app.configure('development', function() {
            self.app.locals.pretty = true;
        });
    };

    /**
     * Setup routing table
     */
    self._setupRoutes = function() {
        var authMiddleware = ensureAuthenticated('/');
        var adminMiddleware = ensureAuthenticated('/', true);

        self.app.post('/login', passport.authenticate('local', {
            successRedirect: '/lobby',
            failureRedirect: '/',
            failureFlash: true
        }));
        self.app.get('/logout', function(req, res) {
            req.logout();
            res.redirect('/');
        });


        self.app.get('/', routes.index);
        self.app.post('/signup', routes.signup);
        self.app.get('/lobby', authMiddleware, routes.lobby);
        self.app.get('/game', authMiddleware, routes.game);
        self.app.get('/admin', adminMiddleware, routes.admin);
        self.app.post('/admin/add-lang', adminMiddleware, routes.addLang);
        self.app.post('/admin/reinit-exercises', adminMiddleware, routes.reinitExercises);
        self.app.get('/help', routes.help);
    };

    /**
     * Setup the realtime sockets
     */
    self._setupSockets = function() {
        self.sockets = new sockets();
    };

    self._initialize();
};

if (require.main === module) {
    app = new SwiftCODE();
    app.listen();
}
