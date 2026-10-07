# City bike stations

The mobility project's (`helsinki-mobility`) application: every HSL city bike docking station on a
map and in a searchable list, with its free bikes and free docks, in English and Finnish (T-3185).

It reads the helsinki project's `BikeHireDockingStation`s through the project's shared space
reference `city-bikes`, which names the public `helsinki-bikes` Endpoint. It writes nothing and holds
no token: the Portal static host serves it under `/apps/bike-stations/` with the endpoints it may
read in `#jc-config`.

```sh
cd ui
pnpm install && pnpm test      # unit and component tests
pnpm build && pnpm e2e         # the four widths, axe at WCAG 2.1 AA
```
