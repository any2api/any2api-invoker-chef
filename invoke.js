var Invoker = require('./lib/Invoker');
var util = require('any2api-util');



util.readInput(null, function(err, apiSpec, params) {
  if (err) throw err;

  Invoker().invoke({ apiSpec: apiSpec, parameters: params }, function(err) {
    if (err) throw err;
  });
});
