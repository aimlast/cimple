import * as React from "react"
import useEmblaCarousel, { type UseEmblaCarouselType } from "embla-carousel-react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
type CarouselApi = UseEmblaCarouselType[1]
type UseCarouselParameters = Parameters<typeof useEmblaCarousel>
type CarouselOptions = UseCarouselParameters[0]
type CarouselPlugin = UseCarouselParameters[1]
type CarouselContextProps = {
  carouselRef: ReturnType<typeof useEmblaCarousel>[0]
  api: ReturnType<typeof useEmblaCarousel>[1]
  scrollPrev: () => void
  scrollNext: () => void
  canScrollPrev: boolean
  canScrollNext: boolean
} & CarouselOptions
const CarouselContext = React.createContext<CarouselContextProps | null>(null)
function useCarousel() {
  const context = React.useContext(CarouselContext)
  if (!context) {
    throw new Error("useCarousel must be used within a <Carousel />") }
  return context
}
const Carousel = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { opts?: CarouselOptions; plugins?: CarouselPlugin }>(({ opts, plugins, className, children, ...props }, ref) => {
  const [carouselRef, api] = useEmblaCarousel(opts, plugins)
  const [canScrollPrev, setCanScrollPrev] = React.useState(false)
  const [canScrollNext, setCanScrollNext] = React.useState(false)
  const scrollPrev = React.useCallback(() => api?.scrollPrev(), [api])
  const scrollNext = React.useCallback(() => api?.scrollNext(), [api])
  const handleSelect = React.useCallback((embla: CarouselApi) => {
    setCanScrollPrev(embla.canScrollPrev())
    setCanScrollNext(embla.canScrollNext())
  }, [])
  React.useEffect(() => {
    if (!api) return
    handleSelect(api)
    api.on("reInit", handleSelect)
    api.on("select", handleSelect)
    return () => {
      api.off("select", handleSelect)
    }
  }, [api, handleSelect])
  return <CarouselContext.Provider value={{ carouselRef, api, opts, plugins: plugins || [], scrollPrev, scrollNext, canScrollPrev, canScrollNext }} {...props}><div ref={ref} className={cn("relative w-full", className)}>{children}</div></CarouselContext.Provider>
})
Carousel.displayName = "Carousel"
const CarouselContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => {
  const { carouselRef } = useCarousel()
  return <div ref={carouselRef} className="overflow-hidden" {...props}><div ref={ref} className={cn("flex -ml-4", className)} {...props} /></div>
})
CarouselContent.displayName = "CarouselContent"
const CarouselItem = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("min-w-0 shrink-0 grow-0 basis-full pl-4", className)} {...props} />
))
CarouselItem.displayName = "CarouselItem"
const CarouselPrevious = React.forwardRef<HTMLButtonElement, React.ComponentProps<typeof Button>>(({ className, variant = "outline", size = "icon", ...props }, ref) => {
  const { scrollPrev, canScrollPrev } = useCarousel()
  return <Button ref={ref} variant={variant} size={size} className={cn("absolute left-12 top-1/2 z-40 -translate-y-1/2", className)} disabled={!canScrollPrev} onClick={scrollPrev} {...props}><ChevronLeft className="h-4 w-4" /><span className="sr-only">Previous slide</span></Button>
})
CarouselPrevious.displayName = "CarouselPrevious"
const CarouselNext = React.forwardRef<HTMLButtonElement, React.ComponentProps<typeof Button>>(({ className, variant = "outline", size = "icon", ...props }, ref) => {
  const { scrollNext, canScrollNext } = useCarousel()
  return <Button ref={ref} variant={variant} size={size} className={cn("absolute right-12 top-1/2 z-40 -translate-y-1/2", className)} disabled={!canScrollNext} onClick={scrollNext} {...props}><ChevronRight className="h-4 w-4" /><span className="sr-only">Next slide</span></Button>
})
CarouselNext.displayName = "CarouselNext"
export { Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext }
