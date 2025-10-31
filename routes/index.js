var express = require("express");
var router = express.Router();

/* GET home page. */
var path = require("path");

router.get("/", function (_req, res, _next) {
  // serve the static landing page
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

module.exports = router;
