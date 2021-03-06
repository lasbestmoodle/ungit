
var ko = require('../vendor/js/knockout-2.2.1');
var ProgressBarViewModel = require('./controls').ProgressBarViewModel;
var GitGraphViewModel = require('./git-graph').GitGraphViewModel;
var async = require('async');
var GerritIntegrationViewModel = require('./gerrit').GerritIntegrationViewModel;
var StagingViewModel = require('./staging').StagingViewModel;

var idCounter = 0;
var newId = function() { return idCounter++; };


var RepositoryViewModel = function(main, repoPath) {
	var self = this;
	this.status = ko.observable('loading');
	this.remoteErrorPopup = ko.observable();

	this.main = main;
	this.repoPath = repoPath;
	this.gerritIntegration = ko.observable(null);
	this.fetchingProgressBar = new ProgressBarViewModel('fetching-' + this.repoPath);
	this.graph = new GitGraphViewModel(this);
	this.staging = new StagingViewModel(this);
	this.remotes = ko.observable();
	this.showFetchButton = ko.computed(function() {
		return self.graph.hasRemotes();
	});
	this.updateStatus();
	this.watcherReady = ko.observable(false);
	this.showLog = ko.computed(function() {
		return !self.staging.inRebase() && !self.staging.inMerge();
	});
	this.status.subscribe(function(newValue) {
		if (newValue == 'inited') {
			self.update();
			api.watchRepository(repoPath, function() { self.watcherReady(true); });
			if (ungit.config.gerrit) {
				self.gerritIntegration(new GerritIntegrationViewModel(self));
			}
		}
	});
	var hasAutoFetched = false;
	this.remotes.subscribe(function(newValue) {
		if (newValue.length > 0 && !hasAutoFetched) {
			hasAutoFetched = true;
			self.fetch({ nodes: true, tags: true });
		}
	})
}
exports.RepositoryViewModel = RepositoryViewModel;
RepositoryViewModel.prototype.update = function() {
	this.updateStatus();
	this.updateLog();
	this.updateBranches();
	this.updateRemotes();
	this.staging.invalidateFilesDiffs();
}
RepositoryViewModel.prototype.closeRemoteErrorPopup = function() {
	this.remoteErrorPopup(null);
}
RepositoryViewModel.prototype.updateAnimationFrame = function(deltaT) {
	this.graph.updateAnimationFrame(deltaT);
}
RepositoryViewModel.prototype.clickFetch = function() { this.fetch({ nodes: true, tags: true }); }
RepositoryViewModel.prototype.fetch = function(options, callback) {
	if (this.status() != 'inited') return;
	var self = this;

	var programEventListener = function(event) {
		if (event.event == 'credentialsRequested') self.fetchingProgressBar.pause();
		else if (event.event == 'credentialsProvided') self.fetchingProgressBar.unpause();
	};
	this.main.programEvents.add(programEventListener);

	var handleApiRemoteError = function(callback, err, result) {
		callback(err, result);
		return !err || self._isRemoteError(err.errorCode);
	}

	this.fetchingProgressBar.start();
	var jobs = [];
	var remoteTags;
	if (options.nodes) jobs.push(function(done) { api.query('POST', '/fetch', { path: self.repoPath, socketId: api.socketId }, function(err, result) {
			done(err, result);
			return !err || self._isRemoteError(err.errorCode);
		}); 
	});
	if (options.tags) jobs.push(function(done) { api.query('GET', '/remote/tags', { path: self.repoPath, socketId: api.socketId }, function(err, result) {
			remoteTags = result;
			done(err, result);
			return !err || self._isRemoteError(err.errorCode);
		});
	});
	async.parallel(jobs, function(err, result) {
		self.main.programEvents.remove(programEventListener);
		self.fetchingProgressBar.stop();

		if (err) {
			self.remoteErrorPopup(self._remoteErrorCodeToString[err.errorCode]);
			return;
		}

		if (options.tags) self.graph.setRemoteTags(remoteTags);
	});
}
RepositoryViewModel.prototype._remoteErrorCodeToString = {
	'remote-timeout': 'Repository remote timeouted.',
	'permision-denied-publickey': 'Permission denied (publickey).',
	'no-supported-authentication-provided': 'No supported authentication methods available. Try starting ssh-agent or pageant.',
	'offline': 'Couldn\'t reach remote repository, are you offline?',
	'proxy-authentication-required': 'Proxy error; proxy requires authentication.',
	'no-remote-configured': 'No remote to list refs from.',
	'ssh-bad-file-number': 'Got "Bad file number" error. This usually indicates that the port listed for the remote repository can\'t be reached.'
}
RepositoryViewModel.prototype._isRemoteError = function(errorCode) {
	return !!this._remoteErrorCodeToString[errorCode];
}

RepositoryViewModel.prototype.updateStatus = function(opt_callback) {
	var self = this;
	api.query('GET', '/status', { path: this.repoPath }, function(err, status){
		if (err) return;
		self.status('inited');
		self.staging.setFiles(status.files);
		self.staging.inRebase(!!status.inRebase);
		self.staging.inMerge(!!status.inMerge);
		if (status.inMerge) {
			var lines = status.commitMessage.split('\n');
			self.staging.commitMessageTitle(lines[0]);
			self.staging.commitMessageBody(lines.slice(1).join('\n'));
		}
		if (opt_callback) opt_callback();
	});
}
RepositoryViewModel.prototype.updateLog = function() {
	if (this.status() != 'inited') return;
	this.graph.loadNodesFromApi();
}
RepositoryViewModel.prototype.updateBranches = function() {
	if (this.status() != 'inited') return;
	var self = this;
	api.query('GET', '/checkout', { path: this.repoPath }, function(err, branch) {
		if (err && err.errorCode == 'not-a-repository') return true;
		if (err) return;
		self.graph.activeBranch(branch);
	});
}
RepositoryViewModel.prototype.updateRemotes = function() {
	if (this.status() != 'inited') return;
	var self = this;
	api.query('GET', '/remotes', { path: this.repoPath }, function(err, remotes) {
		if (err && err.errorCode == 'not-a-repository') return true;
		if (err) return;
		self.remotes(remotes);
		self.graph.hasRemotes(remotes.length != 0);
	});
}
RepositoryViewModel.prototype.toogleShowBranches = function() {
	this.showBranches(!this.showBranches());
}
RepositoryViewModel.prototype.createNewBranch = function() {
	api.query('POST', '/branches', { path: this.repoPath, name: this.newBranchName() });
	this.newBranchName('');
}


