/*
 * Basic test of successful rollback in replica sets.
 *
 * This test sets up a 3-node set, with an arbiyer and 2 data-bearing nodes, A and B.
 * A is the initial primary node.
 *
 * The test inserts 3 documents into A, and waits for them to replicate to B.  Then, it partitions A
 * from the other nodes, causing it to step down and causing B to be elected primary.
 *
 * Next, 3 more documents inserted into B, and B is partitioned from the arbiter.
 *
 * Next, A is allowed to connect to the arbiter again, and gets reelected primary.  Because the
 * arbiter doesn't know about the writes that B accepted, A becomes primary and we insert 3 new
 * documents.  Now, A and B have diverged.  We heal the remaining network partition, bringing B back
 * into the network.
 *
 * Finally, we expect either A or B to roll back its 3 divergent documents and acquire the other
 * node's.
 */

(function () {
    "use strict";

    var replTest = new ReplSetTest({ name: 'unicomplex', nodes: 3, oplogSize: 1 });
    var nodes = replTest.nodeList();
    //print(tojson(nodes));

    var conns = replTest.startSet();
    var r = replTest.initiate({ "_id": "unicomplex",
        "members": [
                             { "_id": 0, "host": nodes[0] },
                             { "_id": 1, "host": nodes[1] },
                             { "_id": 2, "host": nodes[2], arbiterOnly: true}]
    });
    replTest.awaitReplication();
    replTest.bridge();
    replTest.waitForMaster();

    // Make sure we have a master
    var master = replTest.getMaster();
    var a_conn = conns[0];
    var A = a_conn.getDB("admin");
    var b_conn = conns[1];
    a_conn.setSlaveOk();
    b_conn.setSlaveOk();
    var B = b_conn.getDB("admin");
    assert(master == conns[0], "conns[0] assumed to be master");
    assert(a_conn == master);

    // Wait for initial replication
    var a = a_conn.getDB("foo");
    var b = b_conn.getDB("foo");

    /* force the oplog to roll */
    if (new Date() % 2 == 0) {
        print("ROLLING OPLOG AS PART OF TEST (we only do this sometimes)");
        var pass = 1;
        var first = a.getSisterDB("local").oplog.rs.find().sort({ $natural: 1 }).limit(1)[0];
        a.roll.insert({ x: 1 });
        while (1) {
            var bulk = a.roll.initializeUnorderedBulkOp();
            for (var i = 0; i < 1000; i++) {
                bulk.find({}).update({ $inc: { x: 1 }});
            }
            // unlikely secondary isn't keeping up, but let's avoid possible intermittent issues with that.
            bulk.execute({ w: 2 });

            var op = a.getSisterDB("local").oplog.rs.find().sort({ $natural: 1 }).limit(1)[0];
            if (tojson(op.h) != tojson(first.h)) {
                printjson(op);
                printjson(first);
                break;
            }
            pass++;
        }
        print("PASSES FOR OPLOG ROLL: " + pass);
    }
    else {
        print("NO ROLL");
    }

    assert.writeOK(a.bar.insert({ q: 1, a: "foo" }));
    assert.writeOK(a.bar.insert({ q: 2, a: "foo", x: 1 }));
    assert.writeOK(a.bar.insert({ q: 3, bb: 9, a: "foo" }, { writeConcern: { w: 2 } }));

    assert.eq(a.bar.count(), 3, "a.count");
    assert.eq(b.bar.count(), 3, "b.count");

    replTest.partition(0, 1);
    replTest.partition(0, 2);
    assert.soon(function () { try { return B.isMaster().ismaster; } catch(e) { return false; } });

    b.bar.insert({ q: 4 });
    b.bar.insert({ q: 5 });
    b.bar.insert({ q: 6 });
    assert(b.bar.count() == 6, "u.count");

    // a should not have the new data as it was partitioned.
    replTest.partition(1, 2);
    print("*************** wait for server to reconnect ****************");
    replTest.unPartition(0, 2);

    print("*************** B ****************");
    assert.soon(function () { try { return !B.isMaster().ismaster; } catch(e) { return false; } });
    print("*************** A ****************");
    assert.soon(function () { try { return A.isMaster().ismaster; } catch(e) { return false; } });

    assert(a.bar.count() == 3, "t is 3");
    a.bar.insert({ q: 7 });
    a.bar.insert({ q: 8 });
    {
        assert(a.bar.count() == 5);
        var x = a.bar.find().toArray();
        assert(x[0].q == 1, '1');
        assert(x[1].q == 2, '2');
        assert(x[2].q == 3, '3');
        assert(x[3].q == 7, '7');
        assert(x[4].q == 8, '8');
    }

    // A is 1 2 3 7 8
    // B is 1 2 3 4 5 6

    // bring B back online
    replTest.unPartition(0, 1);
    replTest.unPartition(1, 2);
    replTest.awaitSecondaryNodes();
    replTest.awaitReplication();

    friendlyEqual(a.bar.find().sort({ _id: 1 }).toArray(),
                  b.bar.find().sort({ _id: 1 }).toArray(),
                  "server data sets do not match");

    replTest.stopSet(15);
}());

