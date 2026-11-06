#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Objective-C exceptions as Swift errors. Swift can't catch an exception an Objective-C framework raises, and one left
/// uncaught ends the app: AVFoundation raises one when a player node is told to play on an engine that has stopped.
@interface ObjCExceptions : NSObject

/// Runs `block`. An exception it raises comes back as an error: its name is the domain, its reason the description.
+ (BOOL)catching:(NS_NOESCAPE void (^)(void))block error:(NSError *_Nullable *_Nullable)error;

@end

NS_ASSUME_NONNULL_END
