import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized)
@MainActor
struct CronJobsStoreTests {
    @Test(arguments: [false, true])
    func `closing the menu rejects a late job list completion`(succeeds: Bool) async throws {
        let fixture = CronSourceFixture(holding: "cron.list")
        let store = CronJobsStore(gateway: fixture.gateway)
        let refresh = Task { await store.refreshJobs() }
        do {
            try await self.waitUntil { fixture.requests.value.contains { $0.method == "cron.list" } }
            let pending = try #require(fixture.requests.value.first { $0.method == "cron.list" })
            store.stop()
            if succeeds {
                CronSourceFixture.respond(pending)
            } else {
                CronSourceFixture.fail(pending, message: "closed menu failure")
            }
            await refresh.value
            #expect(store.jobs.isEmpty)
        } catch {
            store.stop()
            refresh.cancel()
            await fixture.gateway.shutdown()
            await refresh.value
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test func `opening the menu loads jobs and closing it stops event refresh`() async throws {
        let fixture = CronSourceFixture()
        let store = CronJobsStore(gateway: fixture.gateway)
        do {
            store.start()
            try await self.waitUntil { store.jobs.count == 1 }
            #expect(store.jobs.first?.name == "Gateway A")
            store.stop()
            let count = fixture.requests.value.count
            try self.sendCronEvent(fixture, sequence: 1)
            try await Task.sleep(for: .milliseconds(350))
            #expect(fixture.requests.value.count == count)
        } catch {
            store.stop()
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test func `replacement event refresh waits for its canceled predecessor to drain`() async throws {
        let (lookups, entered) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let (releases, release) = AsyncStream<Void>.makeStream()
        let heldLookup = Task { for await _ in releases {} }
        let holdNextLookup = LockIsolated(false)
        let fixture = CronSourceFixture(beforeEndpointLookup: {
            guard holdNextLookup.withValue({ value in
                defer { value = false }
                return value
            }) else { return }
            entered.yield(())
            await heldLookup.value
        })
        let store = CronJobsStore(gateway: fixture.gateway)
        func cleanup() async {
            release.finish()
            entered.finish()
            store.stop()
            await heldLookup.value
            await fixture.gateway.shutdown()
        }
        do {
            store.start()
            try await self.waitUntil { store.jobs.count == 1 }
            fixture.emptyJobLists.setValue(true)
            holdNextLookup.setValue(true)
            try self.sendCronEvent(fixture, sequence: 1)
            let reachedGate = try await AsyncTimeout.withTimeout(
                seconds: 2,
                onTimeout: { URLError(.timedOut) },
                operation: {
                    for await _ in lookups {
                        return true
                    }
                    return false
                })
            try #require(reachedGate)
            let count = fixture.requests.value.count { $0.method == "cron.list" }
            try self.sendCronEvent(fixture, sequence: 2)
            try await Task.sleep(for: .milliseconds(350))
            #expect(fixture.requests.value.count { $0.method == "cron.list" } == count)
            release.finish()
            try await self.waitUntil { store.jobs.isEmpty }
            #expect(fixture.requests.value.count { $0.method == "cron.list" } > count)
        } catch {
            await cleanup()
            throw error
        }
        await cleanup()
    }

    private func sendCronEvent(_ fixture: CronSourceFixture, sequence: Int) throws {
        let request = try #require(fixture.requests.value.last)
        let event = #"{"type":"event","event":"cron","seq":\#(sequence),"payload":{"jobId":"shared-job","action":"finished"}}"#
        request.socket.emitReceiveSuccess(.string(event))
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(2)
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(2))
        }
        try #require(condition())
    }
}
