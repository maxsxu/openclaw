import Foundation
import Observation
import OpenClawKit
import OSLog

@MainActor
@Observable
final class CronJobsStore {
    static let shared = CronJobsStore()

    private struct Snapshot {
        let source: GatewayConnection.ServerLease?
        let jobs: [CronJob]
    }

    private var cachedSnapshot: Snapshot?
    var jobs: [CronJob] {
        guard let snapshot = self.cachedSnapshot else { return [] }
        // A closed menu misses retirement receipts. Revalidate the cached owner
        // before reopening can expose rows from the previous Gateway.
        if let lease = snapshot.source {
            guard lease.endpointRevision == self.gateway.selectedEndpointRevision,
                  self.gateway.serverLeaseMatchesCurrentRoute(lease) else { return [] }
        }
        return snapshot.jobs
    }

    private var isLoadingJobs = false
    private let logger = Logger(subsystem: "ai.openclaw", category: "cron.ui")
    private var refreshTask: Task<Void, Never>?
    private var eventTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var jobsGeneration: UInt64 = 0
    private let gateway: GatewayConnection
    private let interval: TimeInterval = 30
    private let isPreview: Bool

    init(gateway: GatewayConnection = .shared, isPreview: Bool = ProcessInfo.processInfo.isPreview) {
        self.gateway = gateway
        self.isPreview = isPreview
    }

    func start() {
        guard !self.isPreview, self.eventTask == nil else { return }
        self.eventTask = Task { [weak self, gateway] in
            for await delivery in await gateway.subscribe() {
                guard !Task.isCancelled, let self else { return }
                self.handle(delivery: delivery)
            }
        }
        SimpleTaskSupport.startDetachedLoop(task: &self.pollTask, interval: self.interval) { [weak self] in
            await self?.refreshJobs()
        }
    }

    func stop() {
        self.jobsGeneration &+= 1
        self.isLoadingJobs = false
        SimpleTaskSupport.stop(task: &self.refreshTask)
        SimpleTaskSupport.stop(task: &self.eventTask)
        SimpleTaskSupport.stop(task: &self.pollTask)
    }

    func refreshJobs() async {
        guard !self.isLoadingJobs, !Task.isCancelled else { return }
        // Stop invalidates manual refreshes too, even when their task is owned
        // by the caller instead of this store.
        self.jobsGeneration &+= 1
        let generation = self.jobsGeneration
        let sourceRevision = self.gateway.selectedEndpointRevision
        self.isLoadingJobs = true
        defer {
            if self.jobsGeneration == generation { self.isLoadingJobs = false }
        }

        var requestLease: GatewayConnection.ServerLease?
        do {
            let lease = try await self.gateway.acquireServerLease()
            requestLease = lease
            guard self.ownsJobsRequest(generation, lease: lease) else { return }
            self.adoptSource(lease)
            let jobs = try await self.gateway.cronList(includeDisabled: true, ifCurrentServerLease: lease)
            guard self.ownsJobsRequest(generation, lease: lease) else { return }
            self.cachedSnapshot = Snapshot(source: lease, jobs: jobs)
        } catch {
            guard self.jobsGeneration == generation, !Task.isCancelled,
                  requestLease.map(self.gateway.serverLeaseMatchesCurrentState) ??
                  (self.gateway.selectedEndpointRevision == sourceRevision)
            else { return }
            self.logger.error("cron.list failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private func handle(delivery: GatewayConnection.PushDelivery) {
        guard let push = delivery.push else {
            guard self.cachedSnapshot?.source == delivery.serverLease else { return }
            self.jobsGeneration &+= 1
            self.isLoadingJobs = false
            SimpleTaskSupport.stop(task: &self.refreshTask)
            self.cachedSnapshot = nil
            return
        }
        guard delivery.isCurrent else { return }
        if self.cachedSnapshot?.source != delivery.serverLease {
            self.adoptSource(delivery.serverLease)
            self.jobsGeneration &+= 1
            self.isLoadingJobs = false
            self.scheduleRefresh(delayMs: 0)
        }
        switch push {
        case .snapshot:
            // A replay on the current lease cannot supersede its active list read.
            break
        case let .event(event) where event.event == "cron":
            self.scheduleRefresh()
        case .seqGap:
            self.scheduleRefresh()
        default:
            break
        }
    }

    private func scheduleRefresh(delayMs: Int = 250) {
        let previousTask = self.refreshTask
        previousTask?.cancel()
        self.refreshTask = Task { [weak self] in
            // Drain the canceled request before its successor checks the loading
            // state, or the successor could skip the only queued refresh.
            await previousTask?.value
            guard await SimpleTaskSupport.waitForNextOperation(interval: TimeInterval(delayMs) / 1000) else { return }
            await self?.refreshJobs()
        }
    }

    private func ownsJobsRequest(_ generation: UInt64, lease: GatewayConnection.ServerLease) -> Bool {
        self.jobsGeneration == generation && self.gateway.serverLeaseMatchesCurrentState(lease) && !Task.isCancelled
    }

    private func adoptSource(_ lease: GatewayConnection.ServerLease) {
        guard self.cachedSnapshot?.source != lease else { return }
        self.cachedSnapshot = Snapshot(source: lease, jobs: [])
    }
}

#if DEBUG
extension CronJobsStore {
    /// Synthetic menu fixtures keep screenshot capture independent of a live Gateway.
    func seedDebugFixtureJobs() {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        func job(_ id: String, _ name: String, nextInMinutes: Int) -> CronJob {
            CronJob(
                id: id,
                name: name,
                enabled: true,
                state: .init(nextRunAtMs: now + nextInMinutes * 60000))
        }
        self.cachedSnapshot = Snapshot(source: nil, jobs: [
            job("fixture-1", "Morning Brief", nextInMinutes: 13),
            job("fixture-2", "Inbox Sweep With A Deliberately Long Name", nextInMinutes: 180),
            job("fixture-3", "Weekly Digest", nextInMinutes: 720),
        ])
    }
}
#endif
